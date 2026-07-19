import { describe, it, expect } from "vitest";
import { defineCheck, resetFlowChecks, runTraceChecks } from "../src/agent-task/checks/flow-runner.ts";
import type { TraceProjectionSnapshot, TraceProjectionObservation } from "../src/agent-task/trace-projection/types.ts";

/**
 * SPEC-130 Track D, Test 21: every `t.*` assertion behaves correctly against a
 * TraceProjectionSnapshot fixture.
 *
 * Originally this compared the legacy Flow path against the projection path to
 * gate the FlowTee retirement. The Flow path has now been removed, so this
 * exercises only the projection-first `runTraceChecks` against a single "rich"
 * snapshot fixture (tools, messages, skills, subagents, timing) and asserts the
 * expected pass/fail outcome for each assertion method.
 */

// ── A shared "rich" fixture: tools, messages, skills, subagents, timing ────

function obs(partial: Partial<TraceProjectionObservation>): TraceProjectionObservation {
  return {
    spanId: partial.spanId ?? "span-x",
    type: partial.type ?? "SPAN",
    name: partial.name ?? "x",
    status: partial.status ?? "unset",
    ...partial,
  };
}

const RICH_SNAPSHOT: TraceProjectionSnapshot = {
  schemaVersion: 1,
  projectionVersion: 1,
  source: "local",
  trace: {
    traceId: "flow-trace",
    startedAt: new Date(1000).toISOString(),
    endedAt: new Date(4000).toISOString(),
    durationMs: 3000,
    complete: true,
  },
  capabilities: {
    messages: "available",
    tools: "available",
    errors: "available",
    timing: "available",
    skills: "available",
    subagents: "available",
  },
  observations: [
    obs({ spanId: "m1", type: "GENERATION", name: "user", messages: [{ role: "user", content: "please review this code" }] }),
    obs({ spanId: "t1", type: "TOOL", name: "read_file", toolName: "read_file", toolParameters: { path: "a.py" }, toolResult: "x", status: "ok", startedAt: "2026-01-01T00:00:00.100Z" }),
    obs({ spanId: "t2", type: "TOOL", name: "read_file", toolName: "read_file", toolParameters: { path: "b.py" }, toolResult: "y", status: "ok", startedAt: "2026-01-01T00:00:00.101Z" }),
    obs({ spanId: "t3", type: "TOOL", name: "search", toolName: "search", toolParameters: { q: "bug" }, toolResult: "z", status: "error", errorMessage: "failed", startedAt: "2026-01-01T00:00:00.102Z" }),
    obs({ spanId: "s1", type: "SKILL", name: "code-review", startedAt: "2026-01-01T00:00:00.103Z" }),
    obs({ spanId: "a1", type: "AGENT", name: "researcher", output: "found", status: "ok", startedAt: "2026-01-01T00:00:00.104Z" }),
    obs({ spanId: "m2", type: "GENERATION", name: "assistant", messages: [{ role: "assistant", content: "found a finding in source.py" }] }),
  ],
};

type TestContext = import("../src/agent-task/checks/t.ts").TestContext;

async function runSnapshot(checkFn: (t: TestContext) => void) {
  resetFlowChecks();
  defineCheck("snapshot", checkFn);
  const results = await runTraceChecks({ snapshot: RICH_SNAPSHOT, deliverables: {} });
  return results[0]!;
}

describe("SPEC-130 Track D — projection assertions (Test 21)", () => {
  it("calledTool matches the same name", async () => {
    const result = await runSnapshot((t) => {
      t.calledTool("read_file", { count: 2 });
    });
    expect(result.pass).toBe(true);
  });

  it("calledTool fails when the tool was not called", async () => {
    const result = await runSnapshot((t) => {
      t.calledTool("nonexistent");
    });
    expect(result.pass).toBe(false);
  });

  it("notCalledTool passes for an uncalled tool", async () => {
    const result = await runSnapshot((t) => {
      t.notCalledTool("write_file");
    });
    expect(result.pass).toBe(true);
  });

  it("toolOrder passes for a matching subsequence", async () => {
    const result = await runSnapshot((t) => {
      t.toolOrder(["read_file", "search"]);
    });
    expect(result.pass).toBe(true);
  });

  it("toolOrder fails for a wrong order", async () => {
    const result = await runSnapshot((t) => {
      t.toolOrder(["search", "read_file"]);
    });
    expect(result.pass).toBe(false);
  });

  it("usedNoTools fails when tools were used", async () => {
    const result = await runSnapshot((t) => {
      t.usedNoTools();
    });
    expect(result.pass).toBe(false);
  });

  it("maxToolCalls passes under the limit", async () => {
    const result = await runSnapshot((t) => {
      t.maxToolCalls(5);
    });
    expect(result.pass).toBe(true);
  });

  it("noFailedActions fails when one tool errored", async () => {
    const result = await runSnapshot((t) => {
      t.noFailedActions();
    });
    expect(result.pass).toBe(false);
  });

  it("loadedSkill passes for a loaded skill", async () => {
    const result = await runSnapshot((t) => {
      t.loadedSkill("code-review");
    });
    expect(result.pass).toBe(true);
  });

  it("calledSubagent passes for a called subagent", async () => {
    const result = await runSnapshot((t) => {
      t.calledSubagent("researcher");
    });
    expect(result.pass).toBe(true);
  });

  it("messageIncludes passes when the reply contains the token", async () => {
    const result = await runSnapshot((t) => {
      t.messageIncludes("finding");
    });
    expect(result.pass).toBe(true);
  });

  it("maxTurns holds under the turn budget", async () => {
    const result = await runSnapshot((t) => {
      t.maxTurns(2);
    });
    expect(result.pass).toBe(true);
  });

  it("maxDurationMs passes when timing is available and under budget", async () => {
    const result = await runSnapshot((t) => {
      t.maxDurationMs(5000);
    });
    expect(result.pass).toBe(true);
  });

  it("value assertion (t.check) is unaffected by trace evidence", async () => {
    resetFlowChecks();
    defineCheck("value-parity", (t, { deliverables }) => {
      const answer = (deliverables as { answer?: string }).answer ?? "";
      t.check(answer, { label: "answer is hello", test: (v: unknown): boolean => v === "hello" });
    });
    const result = await runTraceChecks({ snapshot: RICH_SNAPSHOT, deliverables: { answer: "hello" } });
    expect(result[0]!.pass).toBe(true);
  });

  it("calledTool with { status: 'error' } matches an errored tool", async () => {
    const result = await runSnapshot((t) => {
      t.calledTool("search", { status: "error" });
    });
    expect(result.pass).toBe(true);
  });
});
