import { describe, it, expect } from "vitest";
import { getRunSummary } from "../trace-tree-utils";
import type { TraceObservation } from "../contexts";

function makeCall(overrides: Partial<TraceObservation> & { id: string }): TraceObservation {
  return {
    step_index: 0,
    step_name: null,
    model: "unknown",
    created_at: "2026-01-01T00:00:00.000Z",
    latency_ms: null,
    cost: null,
    input: null,
    output: null,
    task_id: null,
    parent_call_id: null,
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
    ...overrides,
  } as TraceObservation;
}

describe("getRunSummary", () => {
  // Regression: the trace header rendered call.cost (micro-USD) as if it were
  // USD, so a $0.44 run showed as "$440892.0000".
  it("renders the aggregated cost as USD, not micro-USD", () => {
    const calls = [
      makeCall({ id: "1", cost: 208741 }),
      makeCall({ id: "2", cost: 19307 }),
      makeCall({ id: "3", cost: 212844 }),
    ];
    expect(getRunSummary(calls).cost).toBe("$0.4409");
  });

  it("keeps sub-cent totals readable", () => {
    expect(getRunSummary([makeCall({ id: "1", cost: 1_000 })]).cost).toBe("$0.001000");
  });

  it("omits cost when nothing was billed", () => {
    expect(getRunSummary([makeCall({ id: "1", cost: 0 })]).cost).toBeNull();
    expect(getRunSummary([makeCall({ id: "1" })]).cost).toBeNull();
  });

  // Numbers from a 16-call Opus run (summed into one call) plus its judge.
  it("names the cache reads inside the token total, and leaves an uncached run's total as it was", () => {
    const cached = getRunSummary([
      makeCall({
        id: "1",
        prompt_tokens: 831_866,
        completion_tokens: 14_197,
        total_tokens: 846_063,
        raw_usage: { input: 38, cache_read: 655_535, cache_write_5m: 176_293, cache_write_1h: 0 },
      }),
      makeCall({ id: "2", prompt_tokens: 1_115, completion_tokens: 1_567, total_tokens: 2_682, raw_usage: { input: 1_115, cache_read: 0 } }),
    ]);
    expect(cached.tokens).toBe("848.7k tok (655.5k cached)");
    expect(cached.tokensTitle).toBe(
      "Input 833.0k: 655.5k read from cache, 176.3k written to cache, 1.2k uncached",
    );

    const uncached = getRunSummary([
      makeCall({ id: "1", prompt_tokens: 900, completion_tokens: 100, total_tokens: 1_000, raw_usage: { input: 900 } }),
    ]);
    expect(uncached.tokens).toBe("1.0k tok");
    expect(uncached.tokensTitle).toBeUndefined();
  });
});
