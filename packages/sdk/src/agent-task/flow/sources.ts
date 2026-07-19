/**
 * Cross-framework Flow normalizers — the "plugs" that let agents NOT built on
 * apo's adapter produce a {@link Flow} from their own output, so the same
 * `t.*` checks work for everyone.
 *
 * Each normalizer is `(source) => Flow`. Add new ones by following the shape.
 *
 * @deprecated SPEC-130 Track D: These are **compatibility recording adapters**,
 * not the primary testing architecture. The canonical path is now the Trace
 * Projection snapshot (`TraceProjectionSnapshot` → `TraceView` →
 * `runTraceChecks`). These normalizers remain available during the
 * deprecation period; `snapshotFromFlow` bridges their output into the
 * projection contract. New integrations should emit standard OTel spans
 * instead of producing a Flow.
 */

import type { Flow, FlowEvent } from "./types.ts";

function safeParse(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ── OpenAI (chat completions message log) ────────────────────────────────

export interface OpenAIMessage {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
}

export function fromOpenAIMessages(messages: OpenAIMessage[]): Flow {
  const events: FlowEvent[] = [];
  // First pass: tool results keyed by tool_call_id.
  const results = new Map<string, unknown>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) {
      results.set(m.tool_call_id, m.content);
    }
  }
  for (const m of messages) {
    if (m.role === "user") {
      events.push({ kind: "message", role: "user", text: m.content ?? "" });
    } else if (m.role === "assistant") {
      events.push({ kind: "message", role: "assistant", text: m.content ?? "" });
      for (const tc of m.tool_calls ?? []) {
        events.push({
          kind: "tool_call",
          name: tc.function?.name ?? "unknown",
          input: safeParse(tc.function?.arguments),
          output: tc.id ? results.get(tc.id) : undefined,
        });
      }
    }
  }
  return { events };
}

// ── Anthropic (messages API content blocks) ──────────────────────────────

export interface AnthropicMessage {
  role?: string;
  content?: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input?: unknown }
    | { type: "tool_result"; tool_use_id: string; content?: unknown }
  >;
}

export function fromAnthropicMessages(messages: AnthropicMessage[]): Flow {
  const events: FlowEvent[] = [];
  const results = new Map<string, unknown>();
  for (const m of messages) {
    for (const block of m.content ?? []) {
      if (block.type === "tool_result") {
        results.set(block.tool_use_id, block.content);
      }
    }
  }
  for (const m of messages) {
    const role = m.role === "user" ? "user" : "assistant";
    for (const block of m.content ?? []) {
      if (block.type === "text") {
        events.push({ kind: "message", role, text: block.text });
      } else if (block.type === "tool_use") {
        events.push({
          kind: "tool_call",
          name: block.name,
          input: block.input,
          output: results.get(block.id),
        });
      }
    }
  }
  return { events };
}

// ── Vercel AI SDK (generateText / streamText result) ─────────────────────

export interface AISDKResult {
  steps?: Array<{
    text?: string;
    toolCalls?: Array<{ toolName: string; input?: unknown }>;
    toolResults?: Array<{ toolName: string; output?: unknown }>;
  }>;
}

export function fromAISDK(result: AISDKResult): Flow {
  const events: FlowEvent[] = [];
  for (const step of result.steps ?? []) {
    if (step.text) {
      events.push({ kind: "message", role: "assistant", text: step.text });
    }
    const outputs = step.toolResults ?? [];
    const toolCalls = step.toolCalls ?? [];
    toolCalls.forEach((tc, i) => {
      events.push({
        kind: "tool_call",
        name: tc.toolName,
        input: tc.input,
        output: outputs[i]?.output,
      });
    });
  }
  return { events };
}
