import { describe, it, expect } from "vitest";
import { computeTimingBounds, getDisplayName, getInlineMetricsStructured } from "../trace-gantt-utils";
import { computeCumulativeMetrics } from "@/lib/cumulative-metrics";
import type { LoggedCall } from "../contexts";

function makeCall(overrides: Partial<LoggedCall> & { id: string }): LoggedCall {
  return {
    step_index: 0,
    step_name: null,
    model: "unknown",
    created_at: "2026-01-01T00:00:00.000Z",
    latency_ms: 100,
    cost: null,
    input: null,
    output: null,
    task_id: null,
    parent_call_id: null,
    ...overrides,
  };
}

describe("computeTimingBounds", () => {
  it("returns defaults for empty array", () => {
    const bounds = computeTimingBounds([]);
    expect(bounds.spanMs).toBe(1);
    expect(bounds.minTs).toBe(0);
    expect(bounds.maxTs).toBe(0);
  });

  it("computes bounds from single call", () => {
    const call = makeCall({
      id: "1",
      created_at: "2026-01-01T00:00:00.000Z",
      latency_ms: 500,
    });
    const bounds = computeTimingBounds([call]);
    expect(bounds.minTs).toBe(new Date("2026-01-01T00:00:00.000Z").getTime());
    expect(bounds.spanMs).toBe(500);
  });

  it("computes bounds from multiple calls", () => {
    const calls = [
      makeCall({
        id: "1",
        created_at: "2026-01-01T00:00:00.000Z",
        latency_ms: 200,
      }),
      makeCall({
        id: "2",
        created_at: "2026-01-01T00:00:00.100Z",
        latency_ms: 800,
      }),
    ];
    const bounds = computeTimingBounds(calls);
    expect(bounds.spanMs).toBe(900);
  });

  it("handles zero-duration calls with spanMs=1", () => {
    const calls = [
      makeCall({
        id: "1",
        created_at: "2026-01-01T00:00:00.000Z",
        latency_ms: 0,
      }),
    ];
    const bounds = computeTimingBounds(calls);
    expect(bounds.spanMs).toBe(1);
  });
});

describe("getDisplayName", () => {
  it("returns step_name when present", () => {
    const call = makeCall({ id: "1", step_name: "Generate Response" });
    expect(getDisplayName(call)).toBe("Generate Response");
  });

  it("returns fallback when no step_name", () => {
    const call = makeCall({ id: "1", step_name: null, step_index: 3 });
    expect(getDisplayName(call)).toBe("Step 3");
  });

  it("returns output summary for tool_use events", () => {
    const call = makeCall({
      id: "1",
      step_name: "Tool Call",
      metadata: { eventType: "tool_use" },
      output: { summary: "Searched database" },
    });
    expect(getDisplayName(call)).toBe("Searched database");
  });

  it("prefers output summary for assistant_reasoning events", () => {
    const call = makeCall({
      id: "1",
      step_name: "Reasoning",
      metadata: { eventType: "assistant_reasoning" },
      output: { summary: "Planned approach" },
    });
    expect(getDisplayName(call)).toBe("Planned approach");
  });

  it("ignores output summary for unknown event types", () => {
    const call = makeCall({
      id: "1",
      step_name: "My Step",
      metadata: { eventType: "other_event" },
      output: { summary: "Some summary" },
    });
    expect(getDisplayName(call)).toBe("My Step");
  });
});

describe("getInlineMetricsStructured tokens", () => {
  it("names the cache reads of a span's descendants and of a leaf call", () => {
    const calls = [
      makeCall({ id: "turn", observation_type: "SPAN" }),
      makeCall({
        id: "gen",
        parent_call_id: "turn",
        prompt_tokens: 47_740,
        completion_tokens: 2_467,
        total_tokens: 50_207,
        raw_usage: { input: 2, cache_read: 25_729, cache_write_5m: 22_009 },
      }),
    ];
    const cumulative = computeCumulativeMetrics(calls);
    const tokens = (id: string) =>
      getInlineMetricsStructured(calls.find((c) => c.id === id)!, cumulative.get(id)).find((m) => m.kind === "tokens")?.text;

    expect(tokens("turn")).toBe("50.2k tok (25.7k cached)");
    expect(tokens("gen")).toBe("50.2k tok (25.7k cached)");
  });
});
