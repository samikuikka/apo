import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  fetchModelPricing,
  matchModelPricing,
  computeCallBreakdown,
  computeRunBreakdown,
  _resetPricingCache,
  type ModelPricing,
} from "../model-pricing";

vi.mock("../config", () => ({
  getBrowserBackendBaseUrl: () => "http://localhost:8000",
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const GPT4O_PRICING: ModelPricing = {
  model_name: "gpt-4o",
  match_pattern: "gpt-4o.*",
  provider: "openai",
  input_price: 2.5,
  output_price: 10.0,
  cached_input_price: 1.25,
};

const CLAUDE_PRICING: ModelPricing = {
  model_name: "claude-3-5-sonnet",
  match_pattern: "claude-3.*sonnet",
  provider: "anthropic",
  input_price: 3.0,
  output_price: 15.0,
  cached_input_price: null,
};

const PRICING_LIST = [GPT4O_PRICING, CLAUDE_PRICING];

beforeEach(() => {
  _resetPricingCache();
  mockFetch.mockReset();
});

describe("fetchModelPricing", () => {
  it("fetches and caches model pricing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(PRICING_LIST),
    });

    const result = await fetchModelPricing();
    expect(result).toEqual(PRICING_LIST);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns cached data on second call", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(PRICING_LIST),
    });

    await fetchModelPricing();
    await fetchModelPricing();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns empty array on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    const result = await fetchModelPricing();
    expect(result).toEqual([]);
  });

  it("returns empty array on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    const result = await fetchModelPricing();
    expect(result).toEqual([]);
  });
});

describe("matchModelPricing", () => {
  it("matches model by regex pattern", () => {
    expect(matchModelPricing("gpt-4o-2024-08-06", PRICING_LIST)).toEqual(
      GPT4O_PRICING,
    );
  });

  it("matches claude model by regex", () => {
    expect(matchModelPricing("claude-3-haiku-sonnet", PRICING_LIST)).toEqual(
      CLAUDE_PRICING,
    );
  });

  it("matches exact model name fallback", () => {
    const pricing: ModelPricing[] = [
      {
        model_name: "my-model",
        match_pattern: "[invalid-regex",
        provider: "test",
        input_price: 1.0,
        output_price: 2.0,
        cached_input_price: null,
      },
    ];
    expect(matchModelPricing("my-model", pricing)).toEqual(pricing[0]);
  });

  it("returns null for empty model name", () => {
    expect(matchModelPricing("", PRICING_LIST)).toBeNull();
  });

  it("returns null for unknown model", () => {
    expect(matchModelPricing("unknown", PRICING_LIST)).toBeNull();
  });

  it("returns null when no match found", () => {
    expect(matchModelPricing("llama-3-70b", PRICING_LIST)).toBeNull();
  });

  it("returns null for empty pricing list", () => {
    expect(matchModelPricing("gpt-4o", [])).toBeNull();
  });
});

describe("computeCallBreakdown", () => {
  it("computes breakdown with full pricing", () => {
    const result = computeCallBreakdown(
      {
        model: "gpt-4o",
        prompt_tokens: 1200,
        completion_tokens: 300,
        cost: 0.006,
      },
      PRICING_LIST,
    );

    expect(result.model).toBe("gpt-4o");
    expect(result.promptTokens).toBe(1200);
    expect(result.completionTokens).toBe(300);
    expect(result.inputPricePer1M).toBe(2.5);
    expect(result.outputPricePer1M).toBe(10.0);
    expect(result.promptCost).toBeCloseTo((1200 / 1_000_000) * 2.5, 10);
    expect(result.completionCost).toBeCloseTo((300 / 1_000_000) * 10.0, 10);
    expect(result.totalCost).toBe(0.006);
    expect(result.hasPricing).toBe(true);
  });

  it("computes calculated total from prompt + completion cost", () => {
    const result = computeCallBreakdown(
      {
        model: "gpt-4o",
        prompt_tokens: 1200,
        completion_tokens: 300,
      },
      PRICING_LIST,
    );

    const expectedPrompt = (1200 / 1_000_000) * 2.5;
    const expectedCompletion = (300 / 1_000_000) * 10.0;
    expect(result.promptCost).toBeCloseTo(expectedPrompt, 10);
    expect(result.completionCost).toBeCloseTo(expectedCompletion, 10);
    expect(result.totalCost).toBeCloseTo(
      expectedPrompt + expectedCompletion,
      10,
    );
    expect(result.calculatedCost).toBeCloseTo(
      expectedPrompt + expectedCompletion,
      10,
    );
  });

  it("preserves provided_cost and calculated_cost", () => {
    const result = computeCallBreakdown(
      {
        model: "gpt-4o",
        prompt_tokens: 1200,
        completion_tokens: 300,
        cost: 0.005,
        provided_cost: 0.005,
        calculated_cost: 0.006,
      },
      PRICING_LIST,
    );

    expect(result.totalCost).toBe(0.005);
    expect(result.providedCost).toBe(0.005);
    expect(result.calculatedCost).toBe(0.006);
  });

  it("handles null tokens", () => {
    const result = computeCallBreakdown(
      {
        model: "gpt-4o",
        prompt_tokens: null,
        completion_tokens: null,
        cost: 0.01,
      },
      PRICING_LIST,
    );

    expect(result.promptTokens).toBeNull();
    expect(result.completionTokens).toBeNull();
    expect(result.promptCost).toBeNull();
    expect(result.completionCost).toBeNull();
    expect(result.totalCost).toBe(0.01);
    expect(result.hasPricing).toBe(true);
  });

  it("handles missing pricing", () => {
    const result = computeCallBreakdown(
      {
        model: "llama-3-70b",
        prompt_tokens: 500,
        completion_tokens: 100,
        cost: 0.001,
      },
      PRICING_LIST,
    );

    expect(result.inputPricePer1M).toBeNull();
    expect(result.outputPricePer1M).toBeNull();
    expect(result.promptCost).toBeNull();
    expect(result.completionCost).toBeNull();
    expect(result.totalCost).toBe(0.001);
    expect(result.hasPricing).toBe(false);
  });

  it("handles missing token fields entirely", () => {
    const result = computeCallBreakdown(
      {
        model: "gpt-4o",
        cost: 0.002,
      },
      PRICING_LIST,
    );

    expect(result.promptTokens).toBeNull();
    expect(result.completionTokens).toBeNull();
    expect(result.promptCost).toBeNull();
    expect(result.completionCost).toBeNull();
    expect(result.totalCost).toBe(0.002);
  });

  it("computes prompt cost only when completion tokens missing", () => {
    const result = computeCallBreakdown(
      {
        model: "gpt-4o",
        prompt_tokens: 1000,
      },
      PRICING_LIST,
    );

    expect(result.promptCost).toBeCloseTo((1000 / 1_000_000) * 2.5, 10);
    expect(result.completionCost).toBeNull();
    expect(result.calculatedCost).toBeNull();
  });
});

describe("computeRunBreakdown", () => {
  it("groups calls by model", () => {
    const calls = [
      { model: "gpt-4o", prompt_tokens: 100, completion_tokens: 50, cost: 0.01 },
      { model: "gpt-4o", prompt_tokens: 200, completion_tokens: 100, cost: 0.02 },
      { model: "claude-3", prompt_tokens: 300, completion_tokens: 150, cost: 0.03 },
    ];

    const result = computeRunBreakdown(calls);

    expect(result).toHaveLength(2);
    const gptEntry = result.find((e) => e.model === "gpt-4o")!;
    const claudeEntry = result.find((e) => e.model === "claude-3")!;

    expect(gptEntry.callCount).toBe(2);
    expect(gptEntry.promptTokens).toBe(300);
    expect(gptEntry.completionTokens).toBe(150);
    expect(gptEntry.cost).toBeCloseTo(0.03, 10);

    expect(claudeEntry.callCount).toBe(1);
    expect(claudeEntry.promptTokens).toBe(300);
    expect(claudeEntry.cost).toBeCloseTo(0.03, 10);
  });

  it("handles empty calls array", () => {
    expect(computeRunBreakdown([])).toEqual([]);
  });

  it("defaults model to 'unknown' when empty", () => {
    const result = computeRunBreakdown([
      { model: "", prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].model).toBe("unknown");
  });

  it("defaults model to 'unknown' when missing", () => {
    const result = computeRunBreakdown([
      { model: undefined as any, prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].model).toBe("unknown");
  });

  it("handles null token and cost values", () => {
    const result = computeRunBreakdown([
      { model: "gpt-4o", prompt_tokens: null, completion_tokens: null, cost: null },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].promptTokens).toBe(0);
    expect(result[0].completionTokens).toBe(0);
    expect(result[0].cost).toBe(0);
  });
});
