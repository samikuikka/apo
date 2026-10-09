/**
 * ConversationTab — a port of the dashboard's ConversationTranscript
 * (agent-task-execution/conversation-transcript.tsx): the rounded card
 * with "Conversation History · N messages", accordion rows with a
 * lowercase role + truncated preview + copy button + rotating chevron,
 * and Tool Call / Tool Output blocks inside assistant/tool messages.
 */
import { useState } from "react";
import type { CapabilitySim } from "../use-capability-sim";
import { INBOUND_EMAIL } from "../capability-sim";
import { Icon } from "../native";

interface ChatMessage {
	readonly role: "user" | "assistant" | "tool";
	readonly content: string;
	/** OpenAI-shape tool calls on assistant messages. */
	readonly toolCalls?: ReadonlyArray<{ name: string; arguments: string }>;
	/** Tool-role messages carry the tool name. */
	readonly name?: string;
}

/** Build the conversation from the sim's spans (user → turns → reply). */
function buildConversation(sim: CapabilitySim): ChatMessage[] {
	const messages: ChatMessage[] = [
		{ role: "user", content: INBOUND_EMAIL.join("\n") },
	];
	for (const span of sim.visibleSpans) {
		if (span.kind === "generation") {
			// The final generation IS the reply deliverable — no extra push.
			if (span.output) messages.push({ role: "assistant", content: span.output });
		} else {
			// OpenAI shape: a tool call hangs off an assistant message — start
			// a bare assistant turn when the previous message was a tool result.
			const last = messages[messages.length - 1];
			if (last?.role !== "assistant") {
				messages.push({ role: "assistant", content: "" });
			}
			const current = messages[messages.length - 1]!;
			messages[messages.length - 1] = {
				...current,
				toolCalls: [...(current.toolCalls ?? []), { name: span.name, arguments: span.input ?? "" }],
			};
			messages.push({ role: "tool", name: span.name, content: span.output ?? "" });
		}
	}
	return messages;
}

function getPreviewText(message: ChatMessage): string {
	const firstCall = message.toolCalls?.[0];
	if (firstCall) {
		const args = firstCall.arguments;
		return `${firstCall.name}(${args.length > 40 ? `${args.slice(0, 40)}...` : args})`;
	}
	const text = message.content;
	return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

function copyTextFor(message: ChatMessage): string {
	if (message.toolCalls && message.toolCalls.length > 0) {
		return JSON.stringify({ role: message.role, content: message.content, tool_calls: message.toolCalls }, null, 2);
	}
	return message.content;
}

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				void navigator.clipboard?.writeText(text);
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1500);
			}}
			className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground/40 transition-colors hover:bg-muted/50 hover:text-muted-foreground"
			title="Copy to clipboard"
			aria-label="Copy to clipboard"
		>
			<Icon name={copied ? "check" : "copy"} className="h-3 w-3" />
		</button>
	);
}

function Chevron({ open }: { open: boolean }) {
	return (
		<Icon
			name="chevron-down"
			className="h-4 w-4 shrink-0 text-muted-foreground/40 transition-transform"
			// Closed rests at -90°, open at 0° — the real accordion's rotation.
			style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
		/>
	);
}

function ToolCallBlock({ name, args }: { name: string; args: string }) {
	const [isOpen, setIsOpen] = useState(false);
	return (
		<div className="overflow-hidden rounded-lg border border-border/60 bg-muted/30">
			<button
				type="button"
				className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
				onClick={() => setIsOpen(!isOpen)}
			>
				<Icon name="wrench" className="h-4 w-4 shrink-0 text-muted-foreground/60" />
				<span className="font-mono text-sm text-foreground">{name}</span>
				<span className="flex-1 truncate font-mono text-sm text-muted-foreground/50">
					{args.length > 50 ? `${args.slice(0, 50)}...` : args}
				</span>
				<div className="flex shrink-0 items-center gap-2">
					<span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">Tool Call</span>
					<Chevron open={isOpen} />
				</div>
			</button>
			{isOpen && (
				<div className="border-t border-border/40 bg-background/30">
					<pre className="overflow-x-auto whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed text-foreground/80">
						{args}
					</pre>
				</div>
			)}
		</div>
	);
}

function ToolOutputBlock({ name, output }: { name: string; output: string }) {
	const [isOpen, setIsOpen] = useState(false);
	return (
		<div className="overflow-hidden rounded-lg border border-border/60 bg-muted/30">
			<button
				type="button"
				className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
				onClick={() => setIsOpen(!isOpen)}
			>
				<Icon name="terminal" className="h-4 w-4 shrink-0 text-success" />
				<span className="font-mono text-sm text-foreground">{name}</span>
				<span className="flex-1 truncate font-mono text-sm text-muted-foreground/50">
					{output.length > 60 ? `${output.slice(0, 60)}...` : output}
				</span>
				<div className="flex shrink-0 items-center gap-2">
					<span className="rounded bg-success/10 px-2 py-0.5 text-xs text-success">Tool Output</span>
					<Chevron open={isOpen} />
				</div>
			</button>
			{isOpen && (
				<div className="border-t border-border/40 bg-background/30">
					<pre className="overflow-x-auto whitespace-pre-wrap p-3 font-mono text-xs leading-relaxed text-foreground/80">
						{output}
					</pre>
				</div>
			)}
		</div>
	);
}

function MessageText({ text }: { text: string }) {
	return (
		<div className="min-w-0 max-w-full overflow-x-auto break-words text-sm leading-relaxed text-foreground/80">
			<p className="whitespace-pre-wrap">{text}</p>
		</div>
	);
}

export function ConversationTab({ sim }: { sim: CapabilitySim }) {
	const conversation = buildConversation(sim);
	const [openIdx, setOpenIdx] = useState<Set<number>>(new Set([0]));

	const toggle = (idx: number) => {
		setOpenIdx((prev) => {
			const next = new Set(prev);
			if (next.has(idx)) next.delete(idx);
			else next.add(idx);
			return next;
		});
	};

	return (
		<div className="overflow-hidden rounded-lg border border-border/60 bg-card/70">
			<div className="flex min-h-[52px] shrink-0 items-center border-b border-border/40 px-4 py-2">
				<h2 className="text-sm font-medium text-foreground">Conversation History</h2>
				<span className="ml-2 text-xs text-muted-foreground">{conversation.length} messages</span>
			</div>

			<div className="max-h-[calc(100vh-400px)] min-h-[200px] overflow-y-auto">
				{conversation.map((message, idx) => {
					const open = openIdx.has(idx);
					return (
						<div key={idx} className="border-b border-border/40 last:border-b-0">
							<div className="flex items-center">
								<button
									type="button"
									className="flex flex-1 items-center justify-between gap-3 px-4 py-3 text-left transition-none hover:bg-muted/30"
									onClick={() => toggle(idx)}
								>
									<div className="flex min-w-0 flex-1 items-center gap-2">
										<span className="min-w-16 shrink-0 text-sm font-medium text-foreground">
											{message.role}
										</span>
										<div className="w-0 flex-1 overflow-hidden">
											<span className="block truncate text-sm text-muted-foreground">
												{getPreviewText(message)}
											</span>
										</div>
									</div>
									<Chevron open={open} />
								</button>
								<div className="flex items-center pr-4">
									<CopyButton text={copyTextFor(message)} />
								</div>
							</div>
							{open && (
								<div className="ml-16 space-y-1.5 px-4 pb-4 pt-0 text-sm">
									{message.role === "assistant" ? (
										<>
											{message.content && <MessageText text={message.content} />}
											{message.toolCalls?.map((tc) => (
												<ToolCallBlock key={tc.name} name={tc.name} args={tc.arguments} />
											))}
										</>
									) : message.role === "tool" ? (
										<ToolOutputBlock name={message.name ?? "tool-result"} output={message.content} />
									) : (
										<MessageText text={message.content} />
									)}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
