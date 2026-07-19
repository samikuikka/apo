"use client";

import { useState, useCallback } from "react";
import { Accordion as AccordionPrimitive } from "radix-ui";
import {
  Wrench,
  Terminal,
  Copy,
  Check,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ExpandableJson } from "@/components/ExpandableJson";
import { Markdown } from "@/components/trace-detail/Markdown";
import { TraceHomeLink } from "@/components/trace-detail";
import type { ChatMessage } from "@/lib/conversation-from-trace";

interface ConversationTranscriptProps {
  /** Conversation messages derived from the linked trace. */
  conversation: ChatMessage[];
  /** Trace id, used to link out to the full viewer from the empty state. */
  traceRunId?: string | null;
}

interface ToolCallInfo {
  id?: string;
  name: string;
  arguments: string;
}

interface ToolResultInfo {
  id: string;
  output: string;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); handleCopy(); }}
      className="inline-flex items-center justify-center h-6 w-6 text-muted-foreground/40 hover:text-muted-foreground cursor-pointer rounded transition-colors hover:bg-muted/50"
      title="Copy to clipboard"
      aria-label="Copy to clipboard"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function ToolCallBlock({ toolCall }: { toolCall: ToolCallInfo }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="border border-border/60 rounded-lg overflow-hidden bg-muted/30">
      <button
        className="flex items-center gap-3 px-3 py-2.5 w-full cursor-pointer hover:bg-muted/40 transition-colors text-left"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <Wrench className="h-4 w-4 text-muted-foreground/60 shrink-0" />
        <span className="text-sm font-mono text-foreground">{toolCall.name}</span>
        <span className="text-sm text-muted-foreground/50 flex-1 truncate font-mono">
          {toolCall.arguments.length > 50 ? toolCall.arguments.slice(0, 50) + "..." : toolCall.arguments}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded">
            Tool Call
          </span>
          <ChevronDown className={cn("h-4 w-4 text-muted-foreground/40 transition-transform", !isOpen && "-rotate-90")} />
        </div>
      </button>
      {isOpen && (
        <div className="border-t border-border/40 bg-background/30">
          <ExpandableJson data={tryParseJson(toolCall.arguments)} />
        </div>
      )}
    </div>
  );
}

function ToolOutputBlock({ result }: { result: ToolResultInfo }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="border border-border/60 rounded-lg overflow-hidden bg-muted/30">
      <button
        className="flex items-center gap-3 px-3 py-2.5 w-full cursor-pointer hover:bg-muted/40 transition-colors text-left"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <ChevronDown className={cn("h-4 w-4 text-muted-foreground/40 shrink-0 transition-transform", !isOpen && "-rotate-90")} />
        <Terminal className="h-4 w-4 text-success shrink-0" />
        <span className="text-sm font-mono text-foreground">{result.id}</span>
        <span className="text-sm text-muted-foreground/50 flex-1 truncate font-mono">
          {result.output.length > 60 ? result.output.slice(0, 60) + "..." : result.output}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-success px-2 py-0.5 bg-success/10 rounded">
            Tool Output
          </span>
          <ChevronDown className={cn("h-4 w-4 text-muted-foreground/40 transition-transform", !isOpen && "-rotate-90")} />
        </div>
      </button>
      {isOpen && (
        <div className="border-t border-border/40 bg-background/30">
          <ExpandableJson data={tryParseJson(result.output)} />
        </div>
      )}
    </div>
  );
}

/** Pull OpenAI-shape tool_calls off an assistant message into a flat list. */
function extractToolCalls(message: ChatMessage): ToolCallInfo[] {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.map((call) => ({
    id: call.id,
    name: call.function?.name ?? "unknown",
    arguments: call.function?.arguments ?? "",
  }));
}

function AssistantMessageContent({ message }: { message: ChatMessage }) {
  const toolCalls = extractToolCalls(message);
  return (
    <div className="space-y-1.5">
      {message.content && (
        <div className="min-w-0 max-w-full overflow-x-auto break-words text-sm text-foreground/80 leading-relaxed">
          <Markdown>{message.content}</Markdown>
        </div>
      )}
      {toolCalls.map((tc) => (
        <ToolCallBlock
          key={`tc-${tc.id ?? tc.name}-${tc.arguments.slice(0, 32)}`}
          toolCall={tc}
        />
      ))}
    </div>
  );
}

function ToolMessageContent({ message }: { message: ChatMessage }) {
  const result: ToolResultInfo = {
    // Tool-role messages don't carry an id in OpenAI shape; fall back to name or content hash.
    id: message.name ?? "tool-result",
    output: message.content,
  };
  return <ToolOutputBlock result={result} />;
}

function getPreviewText(message: ChatMessage): string {
  const firstCall = message.tool_calls?.[0]?.function;
  if (firstCall) {
    const args = firstCall.arguments ?? "";
    return `${firstCall.name}(${args.length > 40 ? args.slice(0, 40) + "..." : args})`;
  }
  const text = message.content ?? "";
  return text.length > 120 ? text.slice(0, 120) + "..." : text;
}

function copyTextFor(message: ChatMessage): string {
  if (message.tool_calls && message.tool_calls.length > 0) {
    return JSON.stringify(
      { role: message.role, content: message.content, tool_calls: message.tool_calls },
      null,
      2,
    );
  }
  return message.content ?? "";
}

const roleConfig: Record<string, { label: string }> = {
  user: { label: "user" },
  assistant: { label: "assistant" },
  system: { label: "system" },
  tool: { label: "tool" },
};

export function ConversationTranscript({
  conversation,
  traceRunId,
}: ConversationTranscriptProps) {
  if (conversation.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/70 px-4 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          No conversation messages in this trace.
        </p>
        {traceRunId && (
          <div className="mt-3 flex justify-center">
            <TraceHomeLink
              traceId={traceRunId}
              label="View full trace"
              appearance="button"
              buttonVariant="outline"
              buttonSize="sm"
            />
          </div>
        )}
      </div>
    );
  }

  const defaultOpen = conversation.length > 0
    ? [`msg-0`]
    : [];

  return (
    <div className="rounded-lg border border-border/60 bg-card/70 overflow-hidden">
      <div className="flex items-center min-h-[52px] px-4 py-2 border-b border-border/40 shrink-0">
        <h2 className="text-sm font-medium text-foreground">Conversation History</h2>
        <span className="ml-2 text-xs text-muted-foreground">{conversation.length} messages</span>
      </div>

      <div className="overflow-y-auto max-h-[calc(100vh-400px)] min-h-[200px]">
        <AccordionPrimitive.Root type="multiple" defaultValue={defaultOpen}>
          {conversation.map((message, idx) => {
            const config = roleConfig[message.role] ?? { label: message.role };
            const preview = getPreviewText(message);
            const id = `msg-${idx}`;
            const copy = copyTextFor(message);
            const isTool = message.role === "tool";

            return (
              <AccordionPrimitive.Item key={id} value={id} className="border-b border-border/40 last:border-b-0">
                <AccordionPrimitive.Header className="flex items-center">
                  <AccordionPrimitive.Trigger className="flex flex-1 items-center justify-between py-3 px-4 gap-3 hover:no-underline hover:bg-muted/30 transition-none text-left [&[data-state=open]>svg.accordion-chevron]:rotate-180">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="text-sm font-medium text-foreground shrink-0 min-w-16">{config.label}</span>
                      <div className="flex-1 w-0 overflow-hidden">
                        <span className="text-sm text-muted-foreground block truncate">{preview}</span>
                      </div>
                    </div>
                    <ChevronDown className="accordion-chevron h-4 w-4 shrink-0 text-muted-foreground/40 transition-transform -rotate-90" />
                  </AccordionPrimitive.Trigger>
                  {/* Sibling (not nested) so we don't put a <button> inside the
                      trigger's <button>, which HTML forbids and React flags as
                      a hydration error. */}
                  <div className="flex items-center pr-4">
                    <CopyButton text={copy} />
                  </div>
                </AccordionPrimitive.Header>
                <AccordionPrimitive.Content className="overflow-hidden text-sm">
                  <div className="pb-4 pt-0 px-4 space-y-1.5 ml-16">
                    {message.role === "assistant" ? (
                      <AssistantMessageContent message={message} />
                    ) : isTool ? (
                      <ToolMessageContent message={message} />
                    ) : (
                      <div className="min-w-0 max-w-full overflow-x-auto break-words text-sm text-foreground/80 leading-relaxed">
                        <Markdown>{message.content}</Markdown>
                      </div>
                    )}
                  </div>
                </AccordionPrimitive.Content>
              </AccordionPrimitive.Item>
            );
          })}
        </AccordionPrimitive.Root>
      </div>
    </div>
  );
}
