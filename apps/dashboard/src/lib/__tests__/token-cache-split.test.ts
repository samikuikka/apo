import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { LoggedCall } from "@/components/trace-detail";
import { callCacheTokens, computeCumulativeMetrics, wholeCallTokens, wholePromptTokens } from "@/lib/cumulative-metrics";
import { formatInputCacheSplit, formatTokenBreakdown, formatTokenTotal } from "@/lib/format";

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

  it("drops the cached suffix when the reads exceed the count they annotate", () => {
    // A pre-#131 legacy row: its columns are net of cache, so the reads are
    // not part of the 4 and the suffix would claim more than it.
    expect(formatTokenBreakdown(4, 365, 33_746)).toBe("4→365 tok");
  });

  it("splits the input into disjoint cache parts, not out of a reported total", () => {
    expect(formatInputCacheSplit(2, 25_729, 22_009)).toBe(
      "Input 47.7k: 25.7k read from cache, 22.0k written to cache, 2 uncached",
    );
    expect(formatInputCacheSplit(1_115, 0, 0)).toBeUndefined();
  });
});

describe("wholePromptTokens", () => {
  it("adds the cache parts to the uncached count, whatever the column says", () => {
    // Post-#131 row: the column carries the input family sum.
    expect(
      wholePromptTokens(call({ id: "sdk", prompt_tokens: 47_740, raw_usage: { input: 2, cache_read: 25_729, cache_write_5m: 22_009 } })),
    ).toBe(47_740);
    // Pre-#131 legacy row: the column is net of cache.
    expect(
      wholePromptTokens(call({ id: "direct", prompt_tokens: 4, raw_usage: { input: 4, cache_read: 33_746, cache_write_5m: 33_746 } })),
    ).toBe(67_496);
  });

  it("falls back to the column when the call has no normalized usage", () => {
    expect(wholePromptTokens(call({ id: "legacy", prompt_tokens: 900 }))).toBe(900);
    expect(wholePromptTokens(call({ id: "bare" }))).toBeNull();
  });

  it("treats a cache-only call as fully cached, never as column + cache", () => {
    // The provider reported cache reads but no uncached input: the gross
    // prompt column holds the reads alone, so falling back to it would count
    // them twice (uncached 1000 + read 1000).
    const cacheOnly = call({ id: "co", prompt_tokens: 1000, raw_usage: { cache_read: 1000 } });
    expect(wholePromptTokens(cacheOnly)).toBe(1000);
    expect(callCacheTokens(cacheOnly)).toEqual({
      cache_read_tokens: 1000,
      cache_write_tokens: 0,
      input_uncached: 0,
    });
  });

  it("keeps the split basis even when it disagrees with the total column", () => {
    // Raw usage is present and sums to zero: the column cannot override it
    // without the chip contradicting the split beside it.
    expect(
      wholeCallTokens(call({ id: "zero", raw_usage: { input: 0 }, total_tokens: 100 })),
    ).toBe(0);
  });
});

describe("computeCumulativeMetrics cache tokens", () => {
  it("sums cache reads, both cache-write TTLs, and the uncached part up the tree", () => {
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
      prompt_uncached_tokens: 1_121,
      cache_read_tokens: 17_651,
      cache_write_tokens: 25_729,
    });
    expect(metrics.get("judge")).toMatchObject({ cache_read_tokens: 0, cache_write_tokens: 0 });
  });

  it("falls back to the column for descendants without normalized usage", () => {
    const metrics = computeCumulativeMetrics([
      call({ id: "root" }),
      call({ id: "legacy", parent_call_id: "root", prompt_tokens: 900 }),
    ]);

    expect(metrics.get("root")?.prompt_uncached_tokens).toBe(900);
  });

  it("does not double-count a cache-only descendant through the column fallback", () => {
    const metrics = computeCumulativeMetrics([
      call({ id: "root" }),
      call({
        id: "co",
        parent_call_id: "root",
        prompt_tokens: 1000,
        raw_usage: { cache_read: 1000 },
      }),
    ]);

    expect(metrics.get("root")).toMatchObject({
      prompt_uncached_tokens: 0,
      cache_read_tokens: 1000,
    });
  });
});

describe("token split laws (generated inputs)", () => {
  const rawUsageArb = fc.record({
    input: fc.nat({ max: 1_000_000 }),
    cache_read: fc.nat({ max: 1_000_000 }),
    cache_write_5m: fc.nat({ max: 1_000_000 }),
    cache_write_1h: fc.nat({ max: 1_000_000 }),
  });

  it("the whole prompt is the disjoint sum of its parts", () => {
    fc.assert(
      fc.property(rawUsageArb, (raw) => {
        expect(wholePromptTokens(call({ id: "p", raw_usage: raw }))).toBe(
          raw.input + raw.cache_read + raw.cache_write_5m + raw.cache_write_1h,
        );
      }),
    );
  });

  it("the whole call total never undercuts the cache parts it must contain", () => {
    // The pre-#131 bug class: a chip total smaller than the cache it
    // claims, which made the "(N cached)" suffix overcount.
    fc.assert(
      fc.property(rawUsageArb, fc.nat({ max: 1_000_000 }), (raw, completion) => {
        const total = wholeCallTokens(
          call({ id: "p", raw_usage: raw, completion_tokens: completion }),
        );
        expect(total).toBeGreaterThanOrEqual(
          raw.cache_read + raw.cache_write_5m + raw.cache_write_1h,
        );
      }),
    );
  });

  it("agrees with the gross columns the projector writes since #131", () => {
    fc.assert(
      fc.property(rawUsageArb, fc.nat({ max: 1_000_000 }), (raw, output) => {
        const gross = raw.input + raw.cache_read + raw.cache_write_5m + raw.cache_write_1h;
        expect(
          wholeCallTokens(
            call({
              id: "p",
              raw_usage: raw,
              prompt_tokens: gross,
              completion_tokens: output,
              total_tokens: gross + output,
            }),
          ),
        ).toBe(gross + output);
      }),
    );
  });

  it("the cached suffix survives only inside a count that can hold it", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), fc.nat({ max: 1_000_000 }), (value, cacheRead) => {
        const label = formatTokenTotal(value, cacheRead);
        if (cacheRead > 0 && cacheRead <= value) expect(label).toContain("cached");
        else expect(label).not.toContain("cached");
      }),
    );
  });
});
