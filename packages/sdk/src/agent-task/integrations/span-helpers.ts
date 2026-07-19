/**
 * Shared span-emission helpers for the tracing integrations.
 *
 * The OpenAI and Anthropic wrappers both need to:
 * 1. Create a GENERATION span before the LLM call
 * 2. End it with text/tokens/latency after the response
 * 3. Emit a TOOL span for each tool call in the response
 *
 * These helpers keep that logic in one place so the wrappers stay thin.
 *
 * @internal
 */

import type { AgentTaskTraceContext } from "../tracing.ts";

function monotonicNowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function safeParse(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Emit a GENERATION span + TOOL spans for a completed LLM call.
 *
 * Both wrappers call this after the SDK returns the response. It:
 * 1. Ends the GENERATION span (created by {@link startGeneration}) with
 *    text, token counts, and latency.
 * 2. Emits a TOOL span per tool call, so `t.calledTool(name)` works.
 */
export function emitGenerationAndTools(
  trace: AgentTaskTraceContext,
  genSpanId: string,
  genStartedAt: number,
  opts: {
    text?: string;
    promptTokens?: number;
    completionTokens?: number;
    toolCalls?: Array<{ name: string; input?: unknown }>;
    taskId?: string;
    turnNumber?: number;
    error?: { message: string };
  },
): void {
  const latency = round3(monotonicNowMs() - genStartedAt);
  const isError = !!opts.error;

  // End the GENERATION span
  trace.endSpan(genSpanId, {
    latency_ms: latency,
    prompt_tokens: opts.promptTokens,
    completion_tokens: opts.completionTokens,
    output: {
      ...(opts.text !== undefined ? { text: opts.text } : {}),
      ...(opts.error ? { error: opts.error.message } : {}),
    },
    ...(isError
      ? { level: "ERROR" as const, status_message: opts.error!.message }
      : {}),
  });

  // Emit TOOL spans (only on success — errors are captured on the GENERATION span)
  if (!isError && opts.toolCalls) {
    for (const tc of opts.toolCalls) {
      const toolSpanId = trace.createSpan({
        task_id: opts.taskId ?? "trace",
        parent_call_id: genSpanId,
        step_name: tc.name,
        observation_type: "TOOL",
        ...(tc.input !== undefined
          ? {
              input:
                tc.input && typeof tc.input === "object"
                  ? (tc.input as Record<string, unknown>)
                  : { value: tc.input },
            }
          : {}),
        metadata: { toolName: tc.name },
      });
      trace.endSpan(toolSpanId, {});
    }
  }
}

/**
 * Create a GENERATION span before the LLM call.
 * Returns `{ spanId, startedAt }` to pass to {@link emitGenerationAndTools}.
 */
export function startGeneration(
  trace: AgentTaskTraceContext,
  opts: {
    model: string;
    system?: string;
    messages?: unknown;
    parentSpanId?: string;
    taskId?: string;
    turnNumber?: number;
  },
): { spanId: string; startedAt: number } {
  const spanId = trace.createSpan({
    task_id: opts.taskId ?? "trace",
    parent_call_id: opts.parentSpanId ?? trace.rootSpanId,
    step_name: "agent.generate",
    model: opts.model,
    observation_type: "GENERATION",
    input: {
      ...(opts.system !== undefined ? { system: opts.system } : {}),
      ...(opts.messages !== undefined ? { messages: opts.messages } : {}),
    },
    metadata: {
      ...(opts.turnNumber !== undefined ? { turnNumber: opts.turnNumber } : {}),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
    },
  });
  return { spanId, startedAt: monotonicNowMs() };
}

// Re-export safeParse for the wrappers (OpenAI arguments is a JSON string)
export { safeParse };
