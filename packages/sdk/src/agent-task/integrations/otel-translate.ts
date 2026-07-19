/**
 * Shared span-translation helpers for the tracing integrations.
 *
 * Maps OpenTelemetry spans from both the Vercel AI SDK (`ai.*` attributes)
 * and the standard GenAI semantic conventions (`gen_ai.*` attributes) to
 * apo's observation types (`TOOL`, `GENERATION`, `AGENT`).
 *
 * Used by:
 * - {@link ApoSpanProcessor} (the OTel-native path)
 * - `createApoTracer` (the per-turn AI SDK tracer)
 *
 * @module
 */

// ── shared utility functions ─────────────────────────────────────────────

import { extractTokenCounts } from "./token-usage.ts";

/** Parse a JSON string, returning the original value if parsing fails. */
export function safeParse(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** High-resolution monotonic timestamp in milliseconds. */
export function monotonicNowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/** Round to 3 decimal places (for latency precision). */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── the translation contract ─────────────────────────────────────────────

/**
 * apo observation types that the FlowTee recognizes. Only spans with one
 * of these types become FlowEvents that `t.*` assertions read.
 */
export type ApoObservationType = "TOOL" | "GENERATION" | "AGENT";

/**
 * The result of translating an OTel span to apo's format.
 * `null` means the span is not load-bearing (housekeeping, internal, etc.)
 * and should be ignored.
 */
export interface TranslatedSpan {
  observationType: ApoObservationType;
  stepName: string;
  /** Model name (for GENERATION spans). */
  model?: string;
  /** Tool call input (for TOOL spans). */
  input?: Record<string, unknown>;
  /** Tool call result (set on end, not start). */
  output?: unknown;
  /** Generation text (for GENERATION spans). */
  text?: string;
  promptTokens?: number;
  completionTokens?: number;
  error?: boolean;
  errorMessage?: string;
}

/**
 * An OTel span's attributes and status, in a shape that doesn't require
 * importing `@opentelemetry/api` at the type level.
 */
export interface OtelSpanData {
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
}

/**
 * Translate an OTel span to apo's observation format.
 *
 * Handles both attribute conventions:
 * - **AI SDK** (`ai.*`): `ai.toolCall.*`, `ai.generateText`, `ai.streamText`
 * - **GenAI standard** (`gen_ai.*`): `gen_ai.tool.*`, `gen_ai.operation.name`
 *
 * Returns `null` for spans that aren't load-bearing (internal housekeeping,
 * non-GenAI operations, etc.).
 */
export function translateOtelSpan(
  spanName: string,
  data: OtelSpanData,
): TranslatedSpan | null {
  const { attributes, status } = data;
  const isError = status.code === 2;
  const errorMessage = status.message;

  // ── AI SDK convention (ai.*) ────────────────────────────────────────

  if (spanName === "ai.toolCall") {
    return {
      observationType: "TOOL",
      stepName: String(attributes["ai.toolCall.name"] ?? "unknown"),
      input: safeParse(attributes["ai.toolCall.args"]) as Record<string, unknown>,
      output: safeParse(attributes["ai.toolCall.result"]),
      error: isError,
      errorMessage,
    };
  }

  // The AI SDK emits a parent span (ai.generateText) and per-step child spans
  // (ai.generateText.doGenerate). The parent span carries:
  // - ai.model.id (at creation)
  // - ai.prompt.messages (the input, at creation)
  // - ai.response.text (the final assembled text, set at end)
  // - ai.usage.promptTokens/completionTokens (total usage, set at end)
  // The child doGenerate spans carry per-step data but NOT the final text.
  // We translate the parent span (which has the complete picture) and skip
  // the per-step child spans.
  if (
    spanName === "ai.generateText" ||
    spanName === "ai.streamText"
  ) {
    return {
      observationType: "GENERATION",
      stepName: "agent.generate",
      text: extractTextFromAttrs(attributes),
      model: String(
        attributes["gen_ai.request.model"] ??
          attributes["ai.model.id"] ??
          attributes["ai.response.model"] ??
          "unknown",
      ),
      ...extractTokenCounts(attributes),
      error: isError,
      errorMessage,
    };
  }

  // ── Standard OTel GenAI conventions (gen_ai.*) ─────────────────────

  const operation = attributes["gen_ai.operation.name"];

  // Tool execution span
  if (
    operation === "execute_tool" ||
    spanName.startsWith("gen_ai.tool") ||
    (spanName.includes("tool") && attributes["gen_ai.tool.name"])
  ) {
    return {
      observationType: "TOOL",
      stepName: String(attributes["gen_ai.tool.name"] ?? "unknown"),
      input: safeParse(attributes["gen_ai.tool.call.arguments"]) as Record<string, unknown>,
      output: safeParse(attributes["gen_ai.tool.call.result"]),
      error: isError,
      errorMessage,
    };
  }

  // Agent invocation span
  if (operation === "invoke_agent") {
    return {
      observationType: "AGENT",
      stepName: String(attributes["gen_ai.agent.name"] ?? "agent"),
      output: safeParse(attributes["gen_ai.tool.call.result"]),
      error: isError,
      errorMessage,
    };
  }

  // Chat / generation span
  if (
    operation === "chat" ||
    operation === "generate_content" ||
    operation === "text_completion"
  ) {
    return {
      observationType: "GENERATION",
      stepName: "agent.generate",
      text: extractTextFromAttrs(attributes, "gen_ai."),
      ...extractTokenCounts(attributes),
      error: isError,
      errorMessage,
    };
  }

  // ── Not a load-bearing span ────────────────────────────────────────

  return null;
}

/**
 * Extract the model's text response from span attributes.
 * Tries both `ai.*` and `gen_ai.*` response keys.
 */
export function extractTextFromAttrs(
  attrs: Record<string, unknown>,
  prefix?: string,
): string | undefined {
  const candidates = prefix === "gen_ai."
    ? ["gen_ai.completion", "gen_ai.response.text"]
    : prefix === "ai."
      ? ["ai.response.text", "ai.response.output", "ai.generateText.result"]
      : [
          "gen_ai.completion",
          "gen_ai.response.text",
          "ai.response.text",
          "ai.response.output",
          "ai.generateText.result",
        ];

  for (const key of candidates) {
    const val = attrs[key];
    if (typeof val === "string" && val.length > 0) {
      const parsed = safeParse(val);
      return typeof parsed === "string" ? parsed : val;
    }
  }
  return undefined;
}
