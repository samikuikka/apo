import { describe, it, expect } from "vitest";
import {
  defineCheck,
  resetFlowChecks,
  runTraceChecks,
} from "../src/agent-task/checks/flow-runner.ts";
import { satisfies } from "../src/agent-task/checks/matchers.ts";
import type { TraceProjectionSnapshot } from "../src/agent-task/trace-projection/types.ts";

function snapshot(
  observations: TraceProjectionSnapshot["observations"],
  capabilities: Partial<TraceProjectionSnapshot["capabilities"]> = {},
): TraceProjectionSnapshot {
  return {
    schemaVersion: 1,
    projectionVersion: 1,
    source: "canonical",
    trace: {
      traceId: "trace-1",
      startedAt: "2026-07-10T10:00:00Z",
      endedAt: "2026-07-10T10:00:04Z",
      complete: true,
    },
    capabilities: {
      messages: "available",
      tools: "available",
      errors: "available",
      timing: "available",
      skills: "available",
      subagents: "available",
      ...capabilities,
    },
    observations,
  };
}

function toolObs(name: string, extra: Partial<TraceProjectionSnapshot["observations"][number]> = {}) {
  return {
    spanId: extra.spanId ?? `span-${name}`,
    type: "TOOL" as const,
    name,
    status: "unset" as const,
    ...extra,
  };
}

describe("runTraceChecks (projection-first API)", () => {
  it("runs registered checks against a TraceProjectionSnapshot", async () => {
    resetFlowChecks();
    defineCheck("uses-tools", (t) => {
      t.calledTool("read_file");
      t.usedNoTools();
    });

    const snap = snapshot([toolObs("read_file", { spanId: "t1", status: "ok" })]);
    const results = await runTraceChecks({ snapshot: snap, deliverables: {} });

    expect(results).toHaveLength(1);
    // calledTool passes, usedNoTools fails → check fails.
    expect(results[0]!.pass).toBe(false);
    expect(results[0]!.reasoning).toContain("tool calls");
  });

  it("records unsupported outcome + pass=false when timing is unavailable", async () => {
    resetFlowChecks();
    defineCheck("duration-check", (t) => {
      t.maxDurationMs(5000);
    });

    const snap = snapshot([], { timing: "unavailable" });
    const results = await runTraceChecks({ snapshot: snap, deliverables: {} });

    expect(results).toHaveLength(1);
    expect(results[0]!.pass).toBe(false);
    const unsupported = results[0]!.assertions?.find((a) => a.outcome === "unsupported");
    expect(unsupported).toBeDefined();
    expect(unsupported!.reasoning).toContain("timing");
  });

  it("records unsupported outcome when errors capability is unavailable", async () => {
    resetFlowChecks();
    defineCheck("no-failures", (t) => {
      t.noFailedActions();
    });

    const snap = snapshot([toolObs("x", { status: "error" })], { errors: "unavailable" });
    const results = await runTraceChecks({ snapshot: snap, deliverables: {} });

    expect(results[0]!.pass).toBe(false);
    const unsupported = results[0]!.assertions?.find((a) => a.outcome === "unsupported");
    expect(unsupported).toBeDefined();
  });

  it("value assertions (t.check) still pass regardless of capabilities", async () => {
    resetFlowChecks();
    defineCheck("value-check", (t, { deliverables }) => {
      t.check(deliverables.answer, satisfies((v: unknown): v is string => typeof v === "string", "answer is string"));
    });

    const snap = snapshot([], { messages: "unavailable", tools: "unavailable", timing: "unavailable" });
    const results = await runTraceChecks({ snapshot: snap, deliverables: { answer: "hello" } });

    expect(results[0]!.pass).toBe(true);
  });

  it("a TOOL observation makes t.calledTool pass", async () => {
    resetFlowChecks();
    defineCheck("tool-parity", (t) => {
      t.calledTool("read_file");
    });

    const snap = snapshot([toolObs("read_file", { spanId: "t1", status: "ok" })]);
    const results = await runTraceChecks({ snapshot: snap, deliverables: {} });
    expect(results[0]!.pass).toBe(true);
  });
});
