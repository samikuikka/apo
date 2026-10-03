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
    /** Reasoning tokens, when the provider reports the dimension. */
    reasoningTokens?: number;
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
    reasoning_tokens: opts.reasoningTokens,
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
 * Resolve the serving host a client actually talks to, from its baseURL.
 *
 * The vendor default (no baseURL) means the SDK's own endpoint. A custom
 * baseURL is the serving host itself — for a known gateway the provider is
 * its name; for anything else the registered domain is the provider and the
 * full host the route, which is exactly the split the backend stores
 * (`gen_ai.provider.name` / `apo.llm.route`, issue #307). Local/private
 * hosts are proxies in front of an unknown backend — report nothing rather
 * than a wrong host.
 */
export function servingHostFromBaseURL(
  baseURL: unknown,
  defaultVendor?: string,
): { provider?: string; route?: string } {
  if (typeof baseURL !== "string" || baseURL.trim() === "") {
    return defaultVendor ? { provider: defaultVendor } : {};
  }
  let host: string;
  try {
    host = new URL(baseURL).hostname;
  } catch {
    return defaultVendor ? { provider: defaultVendor } : {};
  }
  if (
    host === "localhost" ||
    /^(127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  ) {
    return {};
  }
  const known: Record<string, string> = {
    "api.openai.com": "openai",
    "api.anthropic.com": "anthropic",
    "openrouter.ai": "openrouter",
    "api.fireworks.ai": "fireworks",
    "api.groq.com": "groq",
    "api.cerebras.ai": "cerebras",
    "api.deepseek.com": "deepseek",
    "api.mistral.ai": "mistral",
    "api.x.ai": "xai",
    "api.together.xyz": "together",
    "generativelanguage.googleapis.com": "google",
  };
  const provider = known[host];
  if (provider) return { provider };
  const labels = host.split(".");
  if (labels.length < 2) return {};
  return { provider: labels.slice(-2).join("."), route: host };
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
    /** Serving host attributes for this generation (issue #307). */
    provider?: string;
    route?: string;
  },
): { spanId: string; startedAt: number } {
  const spanId = trace.createSpan({
    task_id: opts.taskId ?? "trace",
    parent_call_id: opts.parentSpanId ?? trace.rootSpanId,
    step_name: "agent.generate",
    model: opts.model,
    provider: opts.provider,
    route: opts.route,
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
