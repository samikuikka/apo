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
import { query, type SDKMessage, type SDKAssistantMessage, type SDKResultMessage, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { BetaTextBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";

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

/**
 * Run one agent turn against the Claude Agent SDK.
 *
 * @param prompt      The user's prompt for this turn
 * @param cwd         Working directory the agent operates in (its file access root)
 * @param env         Full environment for the subprocess — MUST include inherited
 *                    vars (PATH, HOME, ANTHROPIC_API_KEY) plus the OTel/TRACEPARENT
 *                    vars the adapter injects. The SDK REPLACES process.env with
 *                    this entirely; it does not merge. The agent reads its own
 *                    model config (CLAUDE_MODEL) from this env — apo never picks.
 * @param allowedTools  Built-in tools to auto-allow without prompting
 * @param mcpServers    Extra MCP servers for this session (task-declared via
 *                      TaskDefinition.mcpServers; the SDK spawns and owns the
 *                      server processes, tools surface as mcp__<name>__<tool>)
 * @param persist     Persist the session to ~/.claude/projects/ (default false).
 *                    The transcript-replay adapter turns this on and replays the
 *                    session JSONL into the run's trace instead of using OTel.
 * @returns           The agent's final text response, whether it errored, and
 *                    the session id (present when persistence is on)
 */
export async function runClaudeAgent(options: {
  prompt: string;
  cwd: string;
  env: Record<string, string | undefined>;
  allowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  persist?: boolean;
}): Promise<{ text: string; is_error: boolean; num_turns: number; session_id?: string }> {
  const stream: AsyncGenerator<SDKMessage, void> = query({
    prompt: options.prompt,
    options: {
      cwd: options.cwd,
      env: options.env,
      // The model is the agent's concern — read CLAUDE_MODEL from the env apo
      // passed (which spreads process.env), falling back to the SDK default.
      model: options.env.CLAUDE_MODEL,
      // Unattended e2e run: allow the SDK's built-in read/search/exec tools
      // without prompting. bypassPermissions requires the explicit opt-in flag.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: options.allowedTools ?? ["Read", "Grep", "Glob", "Bash"],
      // Task-declared MCP servers, injected explicitly — never read from host
      // config (settingSources stays [] below, keeping the run hermetic).
      ...(options.mcpServers && Object.keys(options.mcpServers).length > 0
        ? { mcpServers: options.mcpServers }
        : {}),
      // Hermetic: don't load ~/.claude or .claude/settings — keeps the run
      // reproducible and free of host-specific config.
      settingSources: [],
      // Ephemeral by default; the replay adapter opts into persistence so the
      // session transcript exists on disk to reconstruct the trace from.
      persistSession: options.persist ?? false,
      // Enough headroom for read-then-synthesize without looping on a small model.
      maxTurns: 10,
    },
  });

  // Walk the stream: collect assistant text as it arrives, then capture the
  // terminal result message (always the last message).
  let text = "";
  let result: SDKResultMessage | undefined;
  for await (const message of stream) {
    if (message.type === "assistant") {
      text += assistantText(message);
    } else if (message.type === "result") {
      result = message;
    }
  }

  if (!result) {
    // Stream ended without a result message — shouldn't happen in normal
    // operation, but report honestly rather than fabricate a success.
    return { text, is_error: true, num_turns: 0 };
  }

  // The session id names the persisted transcript file — the replay adapter
  // resolves ~/.claude/projects/*/<session_id>.jsonl from it.
  const sessionId = (result as { session_id?: string }).session_id;

  // On success the SDK sets `result` to the assistant's final synthesized
  // answer; prefer it over our concatenated text (it's the canonical output).
  // On error, `errors[]` holds the failure reasons — surface those instead.
  if (result.subtype === "success") {
    return {
      text: result.result || text,
      is_error: false,
      num_turns: result.num_turns,
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    };
  }
  return {
    text: result.errors.length > 0 ? result.errors.join("\n") : text || "Unknown error",
    is_error: true,
    num_turns: result.num_turns,
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
  };
}
