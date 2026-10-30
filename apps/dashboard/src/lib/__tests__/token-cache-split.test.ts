import { describe, expect, it } from "vitest";
import type { LoggedCall } from "@/components/trace-detail";
import { computeCumulativeMetrics } from "@/lib/cumulative-metrics";
import { formatTokenBreakdown } from "@/lib/format";

function call(overrides: Partial<LoggedCall> & { id: string }): LoggedCall {
  return {
    step_index: 0,
    step_name: null,
    model: "claude-opus-5-5",
    created_at: "2026-01-01T00:00:00.000Z",
    input: null,
    output: null,
    task_id: null,
    parent_call_id: null,
    ...overrides,
  } as LoggedCall;
}

describe("token labels with a prompt cache", () => {
  it("names the cached part of the input, and only when some was read", () => {
    expect(formatTokenBreakdown(832_981, 15_764, 655_535)).toBe("833.0k (655.5k cached)→15.8k tok");
    expect(formatTokenBreakdown(383, 78, 0)).toBe("383→78 tok");
  });
});

describe("computeCumulativeMetrics cache tokens", () => {
  it("sums cache reads and both cache-write TTLs up the tree", () => {
    const metrics = computeCumulativeMetrics([
      call({ id: "root" }),
      call({
        id: "a",
        parent_call_id: "root",
        prompt_tokens: 17_655,
        raw_usage: { input: 4, cache_read: 0, cache_write_5m: 17_651, cache_write_1h: 0 },
      }),
      call({
        id: "b",
        parent_call_id: "root",
        prompt_tokens: 25_731,
        raw_usage: { input: 2, cache_read: 17_651, cache_write_5m: 6_000, cache_write_1h: 2_078 },
      }),
      call({ id: "judge", parent_call_id: "root", prompt_tokens: 1_115, raw_usage: { input: 1_115 } }),
    ]);

    expect(metrics.get("root")).toMatchObject({
      prompt_tokens: 44_501,
      cache_read_tokens: 17_651,
      cache_write_tokens: 25_729,
    });
    expect(metrics.get("judge")).toMatchObject({ cache_read_tokens: 0, cache_write_tokens: 0 });
  });
});
