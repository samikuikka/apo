import { describe, it, expect } from "vitest";
import {
  computeTimingBounds,
  tickInterval,
  barPosition,
  fmtRuler,
  getInlineMetrics,
  getDisplayName,
  flattenGanttTree,
  getTypeLabel,
} from "../trace-gantt-utils";
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

describe("tickInterval", () => {
  it("returns small intervals for short traces", () => {
    const interval = tickInterval(2500, 1);
    expect(interval).toBeLessThanOrEqual(500);
  });

  it("returns larger intervals for long traces", () => {
    const interval = tickInterval(60000, 1);
    expect(interval).toBeGreaterThanOrEqual(1000);
  });

  it("adjusts with zoom", () => {
    const base = tickInterval(10000, 1);
    const zoomed = tickInterval(10000, 10);
    expect(zoomed).toBeLessThanOrEqual(base);
  });

  it("always returns a positive number", () => {
    const interval = tickInterval(1000000, 1);
    expect(interval).toBeGreaterThan(0);
  });
});

describe("barPosition", () => {
  const baseTime = new Date("2026-01-01T00:00:00.000Z").getTime();
  const bounds = {
    minTs: baseTime,
    maxTs: baseTime + 10000,
    spanMs: 10000,
  };

  it("returns null for call without latency", () => {
    const call = makeCall({ id: "1", latency_ms: undefined });
    expect(barPosition(call, bounds, 1)).toBeNull();
  });

  it("computes position for a call at start", () => {
    const call = makeCall({
      id: "1",
      created_at: "2026-01-01T00:00:00.000Z",
      latency_ms: 1000,
    });
    const pos = barPosition(call, bounds, 1);
    expect(pos).not.toBeNull();
    expect(pos!.left).toBe(0);
    expect(pos!.width).toBe(1000);
  });

  it("ensures minimum bar width", () => {
    const call = makeCall({
      id: "1",
      created_at: "2026-01-01T00:00:00.000Z",
      latency_ms: 0.001,
    });
    const pos = barPosition(call, bounds, 1);
    expect(pos!.width).toBe(2);
  });

  it("scales with zoom", () => {
    const call = makeCall({
      id: "1",
      created_at: "2026-01-01T00:00:00.000Z",
      latency_ms: 1000,
    });
    const pos = barPosition(call, bounds, 2);
    expect(pos!.width).toBe(2000);
  });
});

describe("fmtRuler", () => {
  it("formats milliseconds", () => {
    expect(fmtRuler(500)).toBe("500ms");
  });

  it("formats seconds", () => {
    expect(fmtRuler(1500)).toBe("1.5s");
  });

  it("formats zero", () => {
    expect(fmtRuler(0)).toBe("0ms");
  });
});

describe("getInlineMetrics", () => {
  it("returns duration when present", () => {
    const call = makeCall({ id: "1", latency_ms: 1200 });
    const metrics = getInlineMetrics(call);
    expect(metrics).toEqual(["1.20s"]);
  });

  it("includes tokens when > 0", () => {
    const call = makeCall({ id: "1", latency_ms: 100, total_tokens: 500 });
    const metrics = getInlineMetrics(call);
    expect(metrics).toContain("500 tok");
  });

  it("formats large token counts", () => {
    const call = makeCall({ id: "1", latency_ms: 100, total_tokens: 2500 });
    const metrics = getInlineMetrics(call);
    expect(metrics).toContain("2.5k tok");
  });

  it("includes cost when > 0", () => {
    const call = makeCall({ id: "1", latency_ms: 100, cost: 0.01 });
    const metrics = getInlineMetrics(call);
    expect(metrics).toContain("$0.0100");
  });

  it("formats small costs with more precision", () => {
    const call = makeCall({ id: "1", latency_ms: 100, cost: 0.001 });
    const metrics = getInlineMetrics(call);
    expect(metrics).toContain("$0.001000");
  });

  it("uses cumulative metrics for parent nodes", () => {
    const call = makeCall({ id: "1", latency_ms: 100, total_tokens: 10, cost: 0.001 });
    const cumulative = {
      cost: 0.05,
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      latency_ms: 500,
      descendant_count: 3,
    };
    const metrics = getInlineMetrics(call, cumulative);
    expect(metrics).toContain("1.5k tok");
    expect(metrics).toContain("$0.0500");
  });

  it("returns empty array when no metrics", () => {
    const call = makeCall({ id: "1", latency_ms: undefined });
    const metrics = getInlineMetrics(call);
    expect(metrics).toEqual([]);
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

describe("flattenGanttTree", () => {
  it("returns root-run node always", () => {
    const nodes = flattenGanttTree([], new Set(), "");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe("root-run");
    expect(nodes[0].call).toBeNull();
  });

  it("flattens a simple tree", () => {
    const calls = [
      makeCall({ id: "a", parent_call_id: null, step_index: 0 }),
      makeCall({ id: "b", parent_call_id: null, step_index: 1 }),
    ];
    const expanded = new Set(["root-run", "a", "b"]);
    const nodes = flattenGanttTree(calls, expanded, "");
    expect(nodes).toHaveLength(3);
    expect(nodes[0].id).toBe("root-run");
    expect(nodes[1].id).toBe("a");
    expect(nodes[2].id).toBe("b");
  });

  it("respects expand/collapse", () => {
    const calls = [
      makeCall({ id: "parent", parent_call_id: null, step_index: 0 }),
      makeCall({ id: "child", parent_call_id: "parent", step_index: 0 }),
    ];
    const collapsed = new Set(["root-run"]);
    const nodes = flattenGanttTree(calls, collapsed, "");
    expect(nodes).toHaveLength(2);
    expect(nodes[0].id).toBe("root-run");
    expect(nodes[1].id).toBe("parent");
  });

  it("shows children when parent expanded", () => {
    const calls = [
      makeCall({ id: "parent", parent_call_id: null, step_index: 0 }),
      makeCall({ id: "child1", parent_call_id: "parent", step_index: 0 }),
      makeCall({ id: "child2", parent_call_id: "parent", step_index: 1 }),
    ];
    const expanded = new Set(["root-run", "parent"]);
    const nodes = flattenGanttTree(calls, expanded, "");
    expect(nodes).toHaveLength(4);
    expect(nodes.map((n) => n.id)).toEqual(["root-run", "parent", "child1", "child2"]);
  });

  it("computes depth correctly", () => {
    const calls = [
      makeCall({ id: "a", parent_call_id: null }),
      makeCall({ id: "b", parent_call_id: "a" }),
      makeCall({ id: "c", parent_call_id: "b" }),
    ];
    const expanded = new Set(["root-run", "a", "b", "c"]);
    const nodes = flattenGanttTree(calls, expanded, "");
    expect(nodes[0].depth).toBe(0);
    expect(nodes[1].depth).toBe(1);
    expect(nodes[2].depth).toBe(2);
    expect(nodes[3].depth).toBe(3);
  });

  it("filters by search query", () => {
    const calls = [
      makeCall({ id: "a", parent_call_id: null, step_name: "Generate" }),
      makeCall({ id: "b", parent_call_id: null, step_name: "Tool Call" }),
    ];
    const expanded = new Set(["root-run"]);
    const nodes = flattenGanttTree(calls, expanded, "generate");
    expect(nodes).toHaveLength(2);
    expect(nodes[1].id).toBe("a");
  });

  it("includes ancestors of matching nodes in search", () => {
    const calls = [
      makeCall({ id: "parent", parent_call_id: null, step_name: "Parent" }),
      makeCall({ id: "child", parent_call_id: "parent", step_name: "Generate" }),
    ];
    const expanded = new Set(["root-run"]);
    const nodes = flattenGanttTree(calls, expanded, "generate");
    expect(nodes.map((n) => n.id)).toEqual(["root-run", "parent", "child"]);
  });

  it("sets hasChildren correctly", () => {
    const calls = [
      makeCall({ id: "parent", parent_call_id: null }),
      makeCall({ id: "child", parent_call_id: "parent" }),
      makeCall({ id: "leaf", parent_call_id: null }),
    ];
    const expanded = new Set(["root-run", "parent"]);
    const nodes = flattenGanttTree(calls, expanded, "");
    const parent = nodes.find((n) => n.id === "parent");
    const leaf = nodes.find((n) => n.id === "leaf");
    expect(parent!.hasChildren).toBe(true);
    expect(leaf!.hasChildren).toBe(false);
  });
});

describe("getTypeLabel", () => {
  it("returns TRACE for null call", () => {
    expect(getTypeLabel(null)).toBe("TRACE");
  });

  it("returns GEN for model calls", () => {
    const call = makeCall({ id: "1", model: "gpt-4o" });
    expect(getTypeLabel(call)).toBe("GEN");
  });

  it("returns TOOL for tool calls", () => {
    const call = makeCall({ id: "1", tool_name: "search" });
    expect(getTypeLabel(call)).toBe("TOOL");
  });

  it("returns SPAN for generic calls", () => {
    const call = makeCall({ id: "1" });
    expect(getTypeLabel(call)).toBe("SPAN");
  });
});
