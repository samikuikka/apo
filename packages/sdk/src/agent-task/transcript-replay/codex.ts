/**
 * Codex CLI session-transcript parser.
 *
 * Codex writes rollout files under ``~/.codex/sessions/YYYY/MM/DD/``, one
 * JSON object per line:
 *
 *   { type: "session_meta" | "turn_context" | "event_msg" | "response_item",
 *     timestamp, payload }
 *
 * - ``event_msg`` payloads: ``task_started``, ``task_complete``,
 *   ``user_message``, ``agent_message`` (phase ``final_answer`` |
 *   ``commentary``), ``token_count`` (``info.last_token_usage``).
 * - ``response_item`` payloads: ``function_call`` / ``custom_tool_call`` and
 *   their ``*_output`` counterparts (paired by ``call_id``), ``reasoning``
 *   (summary parts), ``web_search_call``.
 *
 * A turn is bracketed by ``task_started`` … ``task_complete``. A rollout that
 * ends mid-turn (harness killed, crash) still yields its turn — the activity
 * happened, the trace should show it — with a warning.
 */

import {
  asNumber,
  asRecord,
  asString,
  laterTimestamp,
  parseMaybeJson,
  parseTranscriptLines,
  sumUsage,
  type JsonObject,
} from "./parse-shared.ts";
import type {
  ParsedTranscriptSession,
  TranscriptToolCall,
  TranscriptTurn,
  TranscriptUsage,
} from "./types.ts";

type OpenTurn = {
  startedAt: string;
  endedAt?: string;
  model?: string;
  userMessage?: string;
  assistantMessage?: string;
  commentary: string[];
  thinking: string[];
  toolCalls: TranscriptToolCall[];
  usage?: TranscriptUsage;
};

export function parseCodexTranscript(content: string): ParsedTranscriptSession {
  const warnings: string[] = [];
  const events = parseTranscriptLines(content, warnings);

  let sessionId = "";
  let cwd: string | undefined;
  const turns: TranscriptTurn[] = [];
  let current: OpenTurn | null = null;
  // Context can arrive just before task_started; remember it for the turn
  // it describes.
  let pendingModel: string | undefined;
  let pendingUserMessage: string | undefined;

  const commit = (reason?: string) => {
    if (current === null) return;
    if (reason !== undefined) warnings.push(reason);
    const turn: TranscriptTurn = {
      index: turns.length,
      startedAt: current.startedAt,
      toolCalls: current.toolCalls,
    };
    if (current.endedAt !== undefined && current.endedAt !== current.startedAt) {
      turn.endedAt = current.endedAt;
    }
    if (current.model !== undefined) turn.model = current.model;
    if (current.userMessage !== undefined) turn.userMessage = current.userMessage;
    if (current.assistantMessage !== undefined) {
      turn.assistantMessage = current.assistantMessage;
    }
    const thinkingText = current.thinking.join("\n");
    if (thinkingText !== "") turn.thinkingText = thinkingText;
    if (current.commentary.length > 0) turn.commentary = [...current.commentary];
    if (current.usage !== undefined) turn.usage = current.usage;
    turns.push(turn);
    current = null;
  };

  for (const event of events) {
    const type = asString(event.type) ?? "";
    const payload = asRecord(event.payload) ?? {};
    const timestamp = asString(event.timestamp) ?? "";

    if (type === "session_meta") {
      if (sessionId === "") sessionId = asString(payload.id) ?? "";
      cwd = cwd ?? asString(payload.cwd);
    } else if (type === "turn_context") {
      const model = asString(payload.model);
      if (model !== undefined) {
        if (current !== null && current.model === undefined) current.model = model;
        else pendingModel = model;
      }
      cwd = cwd ?? asString(payload.cwd);
    } else if (type === "event_msg") {
      const msgType = asString(payload.type) ?? "";
      if (msgType === "task_started") {
        commit("task_started arrived while a turn was still open (missing task_complete)");
        current = {
          startedAt: timestamp,
          commentary: [],
          thinking: [],
          toolCalls: [],
          ...(pendingModel !== undefined ? { model: pendingModel } : {}),
          ...(pendingUserMessage !== undefined ? { userMessage: pendingUserMessage } : {}),
        };
        pendingModel = undefined;
        pendingUserMessage = undefined;
      } else if (msgType === "task_complete") {
        if (current !== null) {
          current.endedAt = timestamp;
          commit();
        }
      } else if (msgType === "user_message") {
        // Can precede task_started, same as turn_context — a leading user
        // message belongs to the turn it opens, not the void before it.
        const message = asString(payload.message);
        if (message !== undefined) {
          if (current !== null) current.userMessage = message;
          else pendingUserMessage = message;
        }
      } else if (current !== null) {
        if (timestamp !== "") current.endedAt = laterTimestamp(current.endedAt, timestamp);
        if (msgType === "agent_message") {
          const message = asString(payload.message);
          if (message !== undefined) {
            if (asString(payload.phase) === "final_answer") {
              current.assistantMessage = message;
            } else {
              current.commentary.push(message);
            }
          }
        } else if (msgType === "token_count") {
          // One token_count per API request: last_token_usage is that
          // request's usage, so a multi-request turn sums them — matching
          // the claude-code parser's per-call accounting.
          const usage = usageOf(asRecord(asRecord(payload.info)?.last_token_usage));
          if (usage !== undefined) current.usage = sumUsage(current.usage, usage);
        }
      }
    } else if (type === "response_item") {
      if (current === null) continue;
      const itemType = asString(payload.type) ?? "";
      if (timestamp !== "") current.endedAt = laterTimestamp(current.endedAt, timestamp);
      if (itemType === "function_call" || itemType === "custom_tool_call") {
        const rawArguments =
          itemType === "custom_tool_call" ? payload.input : payload.arguments;
        current.toolCalls.push({
          callId: asString(payload.call_id) ?? "",
          name: asString(payload.name) ?? "unknown",
          input: parseMaybeJson(rawArguments) ?? asString(rawArguments),
          startedAt: timestamp !== "" ? timestamp : undefined,
        });
      } else if (
        itemType === "function_call_output" ||
        itemType === "custom_tool_call_output"
      ) {
        const callId = asString(payload.call_id) ?? "";
        const call = current.toolCalls.find((c) => callId !== "" && c.callId === callId);
        if (call !== undefined) {
          call.result = asString(payload.output);
          if (timestamp !== "") call.endedAt = timestamp;
        } else {
          warnings.push(`tool output for unknown call_id "${callId}" ignored`);
        }
      } else if (itemType === "reasoning") {
        const summary = reasoningSummaryText(payload);
        if (summary !== undefined) current.thinking.push(summary);
      } else if (itemType === "web_search_call") {
        // Web search has no separate output event; record the query as both.
        const query = asString(asRecord(payload.action)?.query) ?? "";
        current.toolCalls.push({
          callId: `web_search_${timestamp}`,
          name: "web_search",
          input: { query },
          result: `Search: ${query}`,
          startedAt: timestamp !== "" ? timestamp : undefined,
          ...(timestamp !== "" ? { endedAt: timestamp } : {}),
        });
      }
    }
  }
  commit("session ended without task_complete for the last turn");

  return { source: "codex", sessionId, cwd, turns, warnings };
}

/**
 * Reasoning summaries arrive as the Responses API's summary-part array —
 * `{"summary":[{"type":"summary_text","text":"…"}]}` — the shape codex-rs
 * serializes into rollouts. Accept a bare string too for hand-written or
 * older fixtures.
 */
function reasoningSummaryText(payload: JsonObject): string | undefined {
  const summary = payload.summary;
  if (typeof summary === "string") return summary;
  if (Array.isArray(summary)) {
    const text = summary
      .map((part) => asString(asRecord(part)?.text))
      .filter((t): t is string => t !== undefined)
      .join("\n");
    return text !== "" ? text : undefined;
  }
  return asString(payload.text);
}

function usageOf(raw: JsonObject | undefined): TranscriptUsage | undefined {
  if (raw === undefined) return undefined;
  const inputTokens = asNumber(raw.input_tokens);
  const outputTokens = asNumber(raw.output_tokens);
  const cacheReadTokens = asNumber(raw.cached_input_tokens);
  const reasoningTokens = asNumber(raw.reasoning_output_tokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}
