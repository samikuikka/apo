/**
 * The agent — runs the Claude Agent SDK in a subprocess.
 *
 * This is "your agent system." It knows nothing about apo's lifecycle
 * (defineAdapter, startSession, collectDeliverables). It just takes a prompt,
 * a working directory, and an environment, runs `query()`, and returns the
 * final text. Everything prompt/tool/model-related is the SDK's concern.
 *
 * Tracing is automatic: the SDK emits OpenTelemetry natively when the
 * `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` env vars are
 * set (see the adapter), and a W3C `TRACEPARENT` env var (also set by the
 * adapter) links the subprocess's spans to the active apo span. No custom
 * wrapper, no per-call instrumentation.
 *
 * Could run standalone outside apo — `runClaudeAgent({ ... })` is plain code.
 */
import { query, type SDKMessage, type SDKAssistantMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BetaTextBlock, BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";

/** A tool call the SDK performed, surfaced so the adapter can mirror it. */
export type ClaudeToolCall = {
  name: string;
  input: unknown;
};

/** Pull the readable text out of an assistant message's content blocks. */
function assistantText(message: SDKAssistantMessage): string {
  const blocks = message.message.content;
  // The SDK's content blocks are a discriminated union on `.type`. Only the
  // `text` kind carries user-facing prose; tool_use/thinking are internal.
  return blocks
    .filter((block): block is BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Pull the tool calls out of an assistant message's content blocks. */
function assistantToolCalls(message: SDKAssistantMessage): ClaudeToolCall[] {
  return message.message.content
    .filter((block): block is BetaToolUseBlock => block.type === "tool_use")
    .map((block) => ({ name: block.name, input: block.input }));
}

/**
 * Run one agent turn against the Claude Agent SDK.
 *
 * @param prompt      The user's prompt for this turn
 * @param cwd         Working directory the agent operates in (its file access root)
 * @param env         Full environment for the subprocess — MUST include inherited
 *                    vars (PATH, HOME, ANTHROPIC_API_KEY) plus the OTel/TRACEPARENT
 *                    vars the adapter injects. The SDK REPLACES process.env with
 *                    this entirely; it does not merge.
 * @param model       Optional model override (defaults to the SDK's default)
 * @param allowedTools  Built-in tools to auto-allow without prompting
 * @returns           The agent's final text response and whether it errored
 */
export async function runClaudeAgent(options: {
  prompt: string;
  cwd: string;
  env: Record<string, string | undefined>;
  model?: string;
  allowedTools?: string[];
}): Promise<{ text: string; is_error: boolean; num_turns: number; tool_calls: ClaudeToolCall[] }> {
  const stream: AsyncGenerator<SDKMessage, void> = query({
    prompt: options.prompt,
    options: {
      cwd: options.cwd,
      env: options.env,
      model: options.model,
      // Unattended e2e run: allow the SDK's built-in read/search/exec tools
      // without prompting. bypassPermissions requires the explicit opt-in flag.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: options.allowedTools ?? ["Read", "Grep", "Glob", "Bash"],
      // Hermetic: don't load ~/.claude or .claude/settings — keeps the run
      // reproducible and free of host-specific config.
      settingSources: [],
      // Don't persist the session to ~/.claude/projects/ — ephemeral run.
      persistSession: false,
      // Enough headroom for read-then-synthesize without looping on a small model.
      maxTurns: 10,
    },
  });

  // Walk the stream: collect assistant text + tool calls as they arrive, then
  // capture the terminal result message (always the last message).
  let text = "";
  const toolCalls: ClaudeToolCall[] = [];
  let result: SDKResultMessage | undefined;
  for await (const message of stream) {
    if (message.type === "assistant") {
      text += assistantText(message);
      toolCalls.push(...assistantToolCalls(message));
    } else if (message.type === "result") {
      result = message;
    }
  }

  if (!result) {
    // Stream ended without a result message — shouldn't happen in normal
    // operation, but report honestly rather than fabricating a success.
    return { text, is_error: true, num_turns: 0, tool_calls: toolCalls };
  }

  // On success the SDK sets `result` to the assistant's final synthesized
  // answer; prefer it over our concatenated text (it's the canonical output).
  // On error, `errors[]` holds the failure reasons — surface those instead.
  if (result.subtype === "success") {
    return {
      text: result.result || text,
      is_error: false,
      num_turns: result.num_turns,
      tool_calls: toolCalls,
    };
  }
  return {
    text: result.errors.length > 0 ? result.errors.join("\n") : text || "Unknown error",
    is_error: true,
    num_turns: result.num_turns,
    tool_calls: toolCalls,
  };
}
