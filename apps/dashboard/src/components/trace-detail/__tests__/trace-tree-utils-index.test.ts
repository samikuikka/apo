import { describe, it, expect } from "vitest";
import { buildTraceChildrenIndex, compareSiblings } from "../trace-tree-utils";
import type { TraceObservation } from "../contexts";

function makeCall(overrides: Partial<TraceObservation> & { id: string }): TraceObservation {
  return {
    step_index: null,
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

describe("buildTraceChildrenIndex", () => {
  it("groups children per parent with null key holding the roots", () => {
    const index = buildTraceChildrenIndex([
      makeCall({ id: "root", created_at: "2026-01-01T00:00:00.000Z" }),
      makeCall({ id: "a", parent_call_id: "root", created_at: "2026-01-01T00:00:01.000Z" }),
      makeCall({ id: "b", parent_call_id: "root", created_at: "2026-01-01T00:00:02.000Z" }),
    ]);

    expect(index.childrenByParent.get(null)?.map((c) => c.id)).toEqual(["root"]);
    expect(index.childrenByParent.get("root")?.map((c) => c.id)).toEqual(["a", "b"]);
    expect(index.childrenByParent.get("missing")).toBeUndefined();
  });

  it("orders siblings chronologically when step_index is absent (agent-task spans)", () => {
    const index = buildTraceChildrenIndex([
      makeCall({ id: "late", created_at: "2026-01-01T00:00:09.000Z" }),
      makeCall({ id: "early", created_at: "2026-01-01T00:00:01.000Z" }),
      makeCall({ id: "middle", created_at: "2026-01-01T00:00:05.000Z" }),
    ]);

    expect(index.childrenByParent.get(null)?.map((c) => c.id)).toEqual([
      "early",
      "middle",
      "late",
    ]);
  });

  it("prefers step_index over created_at when both siblings carry it", () => {
    const index = buildTraceChildrenIndex([
      makeCall({ id: "second", step_index: 2, created_at: "2026-01-01T00:00:01.000Z" }),
      makeCall({ id: "first", step_index: 1, created_at: "2026-01-01T00:00:09.000Z" }),
    ]);

    expect(index.childrenByParent.get(null)?.map((c) => c.id)).toEqual(["first", "second"]);
  });

  it("sorts mixed siblings by step_index first and leaves nulls chronological", () => {
    const a = makeCall({ id: "a", step_index: 5, created_at: "2026-01-01T00:00:01.000Z" });
    const b = makeCall({ id: "b", step_index: null, created_at: "2026-01-01T00:00:02.000Z" });
    const startMs = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    // step_index only applies when BOTH siblings carry it, matching the
    // tree's historical comparator.
    expect(compareSiblings(a, b, startMs)).toBe(-1);
    expect(compareSiblings(b, a, startMs)).toBe(1);
  });

  it("parses created_at to epoch ms exactly once per call", () => {
    const index = buildTraceChildrenIndex([
      makeCall({ id: "x", created_at: "2026-01-01T12:34:56.789Z" }),
    ]);
    expect(index.startMsById.get("x")).toBe(Date.parse("2026-01-01T12:34:56.789Z"));
  });

  it("treats a span parented to an id missing from the calls array as non-root", () => {
    // Legacy ingestion parents calls to a synthesized root span that never
    // becomes a call row; such children must not silently reappear as roots.
    const index = buildTraceChildrenIndex([
      makeCall({ id: "orphan", parent_call_id: "ghost-root" }),
    ]);
    expect(index.childrenByParent.get(null)).toBeUndefined();
    expect(index.childrenByParent.get("ghost-root")?.map((c) => c.id)).toEqual(["orphan"]);
  });
});
