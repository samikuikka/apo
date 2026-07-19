import { describe, it, expect } from "vitest";

import { extractTokenUsage } from "../../src/agent-task/integrations/token-usage.ts";

/**
 * Contract tests for the shared token-usage extraction helper.
 *
 * Both the createApoTracer path (ai-sdk.ts) and the OTel-native path
 * (otel-translate.ts → otel-processor.ts) must extract token counts from
 * AI SDK span attributes using the SAME logic. This shared helper is what
 * prevents them from drifting apart — the bug where one path dropped tokens
 * while the other didn't.
 *
 * The AI SDK emits usage under `ai.usage.promptTokens` / `ai.usage.completionTokens`.
 * Standard OTel GenAI conventions use `gen_ai.usage.input_tokens` /
 * `gen_ai.usage.output_tokens`. Both must be recognized.
 */
describe("extractTokenUsage", () => {
  it("reads ai.usage.* attributes (Vercel AI SDK convention)", () => {
    const result = extractTokenUsage({
      "ai.usage.promptTokens": 1500,
      "ai.usage.completionTokens": 300,
    });
    expect(result).toEqual({
      prompt_tokens: 1500,
      completion_tokens: 300,
    });
  });

  it("reads gen_ai.usage.* attributes (standard OTel GenAI convention)", () => {
    const result = extractTokenUsage({
      "gen_ai.usage.input_tokens": 2000,
      "gen_ai.usage.output_tokens": 400,
    });
    expect(result).toEqual({
      prompt_tokens: 2000,
      completion_tokens: 400,
    });
  });

  it("prefers standard gen_ai.usage.* when both conventions are present", () => {
    const result = extractTokenUsage({
      "ai.usage.promptTokens": 100,
      "gen_ai.usage.input_tokens": 999,
      "ai.usage.completionTokens": 50,
      "gen_ai.usage.output_tokens": 888,
    });
    expect(result).toEqual({
      prompt_tokens: 999,
      completion_tokens: 888,
    });
  });

  it("returns empty object when no usage attributes present", () => {
    const result = extractTokenUsage({
      "ai.response.text": "hello",
      "ai.model.id": "gpt-4o",
    });
    expect(result).toEqual({});
  });

  it("handles partial usage (only prompt tokens)", () => {
    const result = extractTokenUsage({
      "ai.usage.promptTokens": 500,
    });
    expect(result).toEqual({ prompt_tokens: 500 });
  });

  it("coerces string-valued attributes to numbers", () => {
    // Some emitters serialize attributes as strings.
    const result = extractTokenUsage({
      "ai.usage.promptTokens": "1234",
      "ai.usage.completionTokens": "567",
    });
    expect(result).toEqual({
      prompt_tokens: 1234,
      completion_tokens: 567,
    });
  });

  it("ignores non-numeric string values", () => {
    const result = extractTokenUsage({
      "ai.usage.promptTokens": "not-a-number",
      "ai.usage.completionTokens": 50,
    });
    expect(result).toEqual({ completion_tokens: 50 });
  });

  it("handles empty attributes object", () => {
    expect(extractTokenUsage({})).toEqual({});
  });
});
