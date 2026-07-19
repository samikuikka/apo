import { describe, it, expect } from "vitest";
import { defineCheck, resetFlowChecks, runTraceChecks } from "../src/agent-task/checks/flow-runner.ts";
import { similarity, matchValue } from "../src/agent-task/checks/matchers.ts";
import type { TraceProjectionSnapshot } from "../src/agent-task/trace-projection/types.ts";

// A realistic snapshot: an agent that read two files, searched, ran a compute
// (one of which errored), loaded a skill, and replied.
const snapshot: TraceProjectionSnapshot = {
  schemaVersion: 1,
  projectionVersion: 1,
  source: "local",
  trace: { traceId: "test-trace", complete: true },
  capabilities: {
    messages: "available",
    tools: "available",
    errors: "available",
    timing: "available",
    skills: "available",
    subagents: "unavailable",
  },
  observations: [
    { spanId: "s1", type: "TOOL", name: "read_file", status: "ok", startedAt: "2026-01-01T00:00:01.000Z", toolName: "read_file", toolParameters: { path: "src/a.py" }, output: { lines: 42 } },
    { spanId: "s2", type: "TOOL", name: "read_file", status: "ok", startedAt: "2026-01-01T00:00:02.000Z", toolName: "read_file", toolParameters: { path: "src/b.py" }, output: { lines: 7 } },
    { spanId: "s3", type: "TOOL", name: "search_content", status: "ok", startedAt: "2026-01-01T00:00:03.000Z", toolName: "search_content", toolParameters: { query: "TODO" }, output: { hits: 3 } },
    { spanId: "s4", type: "TOOL", name: "compute", status: "error", startedAt: "2026-01-01T00:00:04.000Z", toolName: "compute", toolParameters: { expr: "1/0" }, output: { error: "div by zero" }, errorMessage: "div by zero" },
    { spanId: "s5", type: "SKILL", name: "code-review", status: "ok", startedAt: "2026-01-01T00:00:05.000Z" },
    { spanId: "s6", type: "GENERATION", name: "agent.generate", status: "ok", startedAt: "2026-01-01T00:00:06.000Z", messages: [{ role: "assistant", content: "Found 2 findings in the code" }] },
  ],
};

function resultsFor(fn: (t: Parameters<Parameters<typeof defineCheck>[1]>[0]) => void) {
  resetFlowChecks();
  defineCheck("under-test", fn);
  return runTraceChecks({ snapshot, deliverables: {} });
}

async function passes(fn: (t: Parameters<Parameters<typeof defineCheck>[1]>[0]) => void) {
  const r = await resultsFor(fn);
  return r[0]!.pass;
}

describe("richer tool-call matching", () => {
  it("matches by name only (count default ≥1)", async () => {
    expect(await passes((t) => t.calledTool("read_file"))).toBe(true);
    expect(await passes((t) => t.calledTool("nope"))).toBe(false);
  });

  it("matches by exact count", async () => {
    expect(await passes((t) => t.calledTool("read_file", { count: 2 }))).toBe(true);
    expect(await passes((t) => t.calledTool("read_file", { count: 3 }))).toBe(false);
  });
});

describe("similarity matcher", () => {
  it("passes near-matches above threshold", () => {
    expect(similarity("hello world").test("hello wrld")).toBe(true);
  });
  it("fails when too far", () => {
    expect(similarity("hello world").test("completely different text")).toBe(false);
  });
  it("respects a custom threshold", () => {
    expect(similarity("abcdef", 0.5).test("abcxyz")).toBe(true);
  });
  it("matchValue: literal / RegExp / predicate", () => {
    expect(matchValue({ a: 1, b: 2 }, { a: 1 })).toBe(true); // partial-deep
    expect(matchValue("path/to/x", /^path/)).toBe(true);
    expect(matchValue(5, (n) => n > 3)).toBe(true);
  });
});
