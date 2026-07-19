/**
 * Derive a flat chat-style conversation from a trace.
 *
 * The task-run page used to render "Conversation History" from `transcript_json`,
 * a coarse SDK-emitted blob that collapsed each agent turn into a single
 * message. That blob is structurally a turn summary, not a conversation, so a
 * multi-step turn rendered as exactly one message.
 *
 * The trace is the real source of truth. Each GENERATION call's `input.messages`
 * is the full prompt the LLM received — for agentic loops that includes every
 * accumulated prior turn (system, user, assistant, tool-call, tool-result). The
 * last generation therefore saw the most context, so its input plus its own
 * output reply is the complete conversation. No cross-call deduplication of
 * accumulated history is needed.
 *
 * Messages are already normalized to OpenAI shape by the backend
 * (`normalize_genai_message` in `otel_normalization/_shared.py`).
 */

import type { LoggedCall, TraceDetail } from "@/components/trace-detail/contexts";
import { getSemanticType } from "@/components/trace-detail/trace-utils";

/** A single chat message in OpenAI shape, as normalized by the backend. */
export interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name: string; arguments: string };
  }>;
  name?: string;
  /** Multimodal content parts (image/audio/file), if present in the source. */
  content_parts?: Array<Record<string, unknown>>;
}

const EMPTY: ConversationView = Object.freeze({ messages: [] });

export interface ConversationView {
  /** Ordered, deduplicated chat messages derived from the trace. */
  messages: ChatMessage[];
}

/**
 * Reconstruct the conversation view from a trace's generation calls.
 *
 * Returns `{ messages: [] }` when there is no trace, no generation calls, or
 * the last generation carries no messages — callers render an empty state.
 */
export function deriveConversationFromTrace(
  trace: TraceDetail | null,
): ConversationView {
  if (!trace || trace.calls.length === 0) return EMPTY;

  const generations = trace.calls
    .filter((call) => isGeneration(call))
    .sort(compareCallOrder);
  if (generations.length === 0) return EMPTY;

  const last = generations[generations.length - 1];
  const inputMessages = readMessages(last.input);
  const outputMessages = readMessages(last.output);
  const combined = [...inputMessages, ...outputMessages];
  if (combined.length === 0) return EMPTY;

  return { messages: dedupe(combined) };
}

function isGeneration(call: LoggedCall): boolean {
  // Prefer the explicit observation_type, then fall back to the same heuristic
  // the trace viewer uses (model set + no tool name).
  if (call.observation_type === "GENERATION") return true;
  return getSemanticType(call) === "GENERATION";
}

/** Match the backend's call ordering: step_index (nulls last), then created_at. */
function compareCallOrder(a: LoggedCall, b: LoggedCall): number {
  if (a.step_index != null && b.step_index != null) {
    if (a.step_index !== b.step_index) return a.step_index - b.step_index;
  } else if (a.step_index != null) {
    return -1;
  } else if (b.step_index != null) {
    return 1;
  }
  return a.created_at.localeCompare(b.created_at);
}

/** Pull `{role, content, tool_calls}` messages out of a generation's input/output. */
function readMessages(payload: unknown): ChatMessage[] {
  if (!payload || typeof payload !== "object") return [];
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (m): m is ChatMessage =>
      typeof m === "object" && m !== null && "role" in m,
  );
}

/** Drop empty messages and collapse adjacent duplicates that share role+content. */
function dedupe(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    if (!isRenderable(msg)) continue;
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.role === msg.role &&
      prev.content === msg.content &&
      sameToolCalls(prev.tool_calls, msg.tool_calls)
    ) {
      continue;
    }
    out.push(msg);
  }
  return out;
}

function isRenderable(msg: ChatMessage): boolean {
  if (msg.content && msg.content.length > 0) return true;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true;
  if (Array.isArray(msg.content_parts) && msg.content_parts.length > 0) return true;
  return false;
}

function sameToolCalls(
  a: ChatMessage["tool_calls"],
  b: ChatMessage["tool_calls"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every(
    (call, i) =>
      call.function?.name === b[i]?.function?.name &&
      call.function?.arguments === b[i]?.function?.arguments,
  );
}
