/**
 * Shared token-usage extraction for the tracing integrations.
 *
 * Both the `createApoTracer` path (`ai-sdk.ts`) and the OTel-native path
 * (`otel-translate.ts` → `otel-processor.ts`) must extract token counts from
 * AI SDK span attributes using the same logic. This helper is the single
 * source of truth — it prevents the two paths from drifting apart (the bug
 * where one path reported tokens and the other silently dropped them).
 *
 * The AI SDK emits usage under `ai.usage.promptTokens` /
 * `ai.usage.completionTokens`. Standard OTel GenAI conventions use
 * `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`. Both are
 * recognized; standard `gen_ai.usage.*` takes precedence when both are present.
 *
 * @internal
 */

type SpanAttributes = Record<string, unknown>;

/**
 * Extract `prompt_tokens` / `completion_tokens` from a span's attributes.
 * Returns an object shaped to spread directly into `trace.endSpan()` params.
 * Omits keys when the corresponding attribute is absent or non-numeric.
 *
 * Recognizes all known attribute-name conventions:
 *   - Vercel AI SDK: `ai.usage.promptTokens` / `ai.usage.completionTokens`
 *   - OTel GenAI: `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`
 *   - OTel GenAI (alt): `gen_ai.usage.prompt_tokens` / `gen_ai.usage.completion_tokens`
 *
 * `gen_ai.usage.*` takes precedence over `ai.usage.*` when both are present.
 */
export function extractTokenUsage(attrs: SpanAttributes): {
  prompt_tokens?: number;
  completion_tokens?: number;
} {
  const prompt_tokens = toNum(
    attrs["gen_ai.usage.input_tokens"] ??
      attrs["gen_ai.usage.prompt_tokens"] ??
      attrs["ai.usage.promptTokens"],
  );
  const completion_tokens = toNum(
    attrs["gen_ai.usage.output_tokens"] ??
      attrs["gen_ai.usage.completion_tokens"] ??
      attrs["ai.usage.completionTokens"],
  );
  const out: { prompt_tokens?: number; completion_tokens?: number } = {};
  if (prompt_tokens !== undefined) out.prompt_tokens = prompt_tokens;
  if (completion_tokens !== undefined) out.completion_tokens = completion_tokens;
  return out;
}

/**
 * Coerce a span attribute value to a number. Accepts numbers directly and
 * parses finite numeric strings; ignores everything else.
 */
function toNum(val: unknown): number | undefined {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = Number(val);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Re-exported so the integrations can read prompt/completion tokens as
 * separate values (the OTel translate path returns them individually, not
 * as an endSpan-ready object).
 */
export function extractTokenCounts(attrs: SpanAttributes): {
  promptTokens?: number;
  completionTokens?: number;
} {
  const { prompt_tokens, completion_tokens } = extractTokenUsage(attrs);
  return {
    ...(prompt_tokens !== undefined ? { promptTokens: prompt_tokens } : {}),
    ...(completion_tokens !== undefined
      ? { completionTokens: completion_tokens }
      : {}),
  };
}
