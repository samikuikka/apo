import { describe, it, expect } from "vitest";
import {
  defineCheck,
  resetFlowChecks,
  runTraceChecks,
} from "../src/agent-task/checks/flow-runner.ts";
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

let spanCounter = 0;
function toolObs(
  name: string,
  input?: unknown,
  extra: Partial<TraceProjectionSnapshot["observations"][number]> = {},
) {
  spanCounter += 1;
  return {
    spanId: extra.spanId ?? `span-${spanCounter}`,
    type: "TOOL" as const,
    name,
    status: "unset" as const,
    ...extra,
    ...(input !== undefined ? { toolParameters: input } : {}),
  };
}

async function runOneCheck(fn: Parameters<typeof defineCheck>[1]) {
  resetFlowChecks();
  defineCheck("under-test", fn);
  const snap = snapshot(currentObservations);
  const results = await runTraceChecks({ snapshot: snap, deliverables: {} });
  expect(results).toHaveLength(1);
  return results[0]!;
}

// Mutated by each it() before calling runOneCheck; keeps test bodies to the
// assertions under test rather than harness assembly.
let currentObservations: TraceProjectionSnapshot["observations"] = [];

function pathKey(call: { input?: unknown }) {
  return (call.input as { path?: string } | undefined)?.path;
}

describe("maxToolCallsPer", () => {
  it("passes when every key is within the limit", async () => {
    currentObservations = [
      toolObs("read_file", { path: "a.txt" }),
      toolObs("read_file", { path: "a.txt" }),
      toolObs("read_file", { path: "b.txt" }),
    ];
    const result = await runOneCheck((t) => {
      t.maxToolCallsPer(2, "read_file", pathKey, { keyLabel: "path" });
    });
    expect(result.pass).toBe(true);
  });

  it("fails naming the violating key and its count", async () => {
    currentObservations = [
      toolObs("read_file", { path: "a.txt" }),
      toolObs("read_file", { path: "a.txt" }),
      toolObs("read_file", { path: "a.txt" }),
    ];
    const result = await runOneCheck((t) => {
      t.maxToolCallsPer(2, "read_file", pathKey, { keyLabel: "path" });
    });
    expect(result.pass).toBe(false);
    const messages = result.assertions.map((a) => a.reasoning).join("\n");
    expect(messages).toContain("a.txt");
    expect(messages).toContain("3");
    const received = JSON.stringify(result.assertions.map((a) => a.received));
    expect(received).toContain("a.txt: 3");
  });

  it("fails closed when a matching call has no key", async () => {
    currentObservations = [toolObs("read_file")];
    const result = await runOneCheck((t) => {
      t.maxToolCallsPer(1, "read_file", pathKey, { keyLabel: "path" });
    });
    expect(result.pass).toBe(false);
    const messages = result.assertions.map((a) => a.reasoning).join("\n");
    expect(messages.toLowerCase()).toContain("path");
  });

  it("ignores non-matching tools", async () => {
    currentObservations = [
      toolObs("compute", { expression: "1+1" }),
      toolObs("compute", { expression: "1+1" }),
      toolObs("compute", { expression: "1+1" }),
      toolObs("read_file", { path: "a.txt" }),
    ];
    const result = await runOneCheck((t) => {
      t.maxToolCallsPer(1, "read_file", pathKey);
    });
    expect(result.pass).toBe(true);
  });

  it("rejects invalid limits like other budgets", async () => {
    currentObservations = [toolObs("read_file", { path: "a.txt" })];
    // The runner records an author error as a check-error assertion rather
    // than rejecting, so assert on the recorded row.
    const negative = await runOneCheck((t) => {
      t.maxToolCallsPer(-1, "read_file", pathKey);
    });
    expect(negative.pass).toBe(false);
    expect(
      negative.assertions.some((a) => a.id === "check-error" && /maxToolCallsPer/.test(a.reasoning)),
    ).toBe(true);
    const infinite = await runOneCheck((t) => {
      t.maxToolCallsPer(Number.POSITIVE_INFINITY, "read_file", pathKey);
    });
    expect(infinite.pass).toBe(false);
    expect(
      infinite.assertions.some((a) => a.id === "check-error" && /maxToolCallsPer/.test(a.reasoning)),
    ).toBe(true);
  });

  it("is unsupported without the tools capability", async () => {
    resetFlowChecks();
    defineCheck("no-tools", (t) => {
      t.maxToolCallsPer(1, "read_file", pathKey);
    });
    const snap = snapshot([toolObs("read_file", { path: "a.txt" })], {
      tools: "unavailable",
    });
    const results = await runTraceChecks({ snapshot: snap, deliverables: {} });
    expect(results[0]!.pass).toBe(false);
    const outcomes = results[0]!.assertions.map((a) => a.outcome).join(",");
    expect(outcomes).toContain("unsupported");
  });

  it("honors a RegExp name matcher (a match-nothing regex must not pass vacuously)", async () => {
    currentObservations = [
      toolObs("read_file_v2", { path: "a.txt" }),
      toolObs("read_file_v2", { path: "a.txt" }),
    ];
    const result = await runOneCheck((t) => {
      t.maxToolCallsPer(1, /^read_file/, pathKey);
    });
    // Both calls share the a.txt key, so a working regex matcher fails the
    // bound; a broken match-nothing regex would pass with zero groups.
    expect(result.pass).toBe(false);
    const messages = result.assertions.map((a) => a.reasoning).join("\n");
    expect(messages).toContain("a.txt");
    expect(messages).toContain("2");
  });

  it("treats a /g RegExp like any other matcher, not alternating matches", async () => {
    currentObservations = [
      toolObs("read_file", { path: "a.txt" }),
      toolObs("read_file", { path: "a.txt" }),
      toolObs("read_file", { path: "a.txt" }),
      toolObs("read_file", { path: "a.txt" }),
    ];
    const result = await runOneCheck((t) => {
      // A global regex advances lastIndex across the per-call filter and
      // counts only every other call if matchName does not strip the flag.
      t.maxToolCallsPer(1, /read_file/g, pathKey);
    });
    expect(result.pass).toBe(false);
    const messages = result.assertions.map((a) => a.reasoning).join("\n");
    expect(messages).toContain("4");
  });

  it("treats limit 0 as a bound: fails on any keyed call, passes on none", async () => {
    currentObservations = [toolObs("read_file", { path: "a.txt" })];
    const withCall = await runOneCheck((t) => {
      t.maxToolCallsPer(0, "read_file", pathKey);
    });
    expect(withCall.pass).toBe(false);
    currentObservations = [toolObs("compute", { expression: "1" })];
    const withoutCall = await runOneCheck((t) => {
      t.maxToolCallsPer(0, "read_file", pathKey);
    });
    expect(withoutCall.pass).toBe(true);
  });

  it("groups numeric and string keys that coerce to the same form", async () => {
    currentObservations = [
      toolObs("charge", { orderId: 1 }),
      toolObs("charge", { orderId: "1" }),
    ];
    const result = await runOneCheck((t) => {
      t.maxToolCallsPer(
        1,
        "charge",
        (call) => (call.input as { orderId?: string | number } | undefined)?.orderId,
        { keyLabel: "order" },
      );
    });
    expect(result.pass).toBe(false);
    const messages = result.assertions.map((a) => a.reasoning).join("\n");
    expect(messages).toContain("2");
  });

  it("surfaces a throwing key function as a check error, never a pass", async () => {
    currentObservations = [toolObs("read_file", { path: "a.txt" })];
    const result = await runOneCheck((t) => {
      t.maxToolCallsPer(1, "read_file", () => {
        throw new Error("key exploded");
      });
    });
    expect(result.pass).toBe(false);
    expect(
      result.assertions.some((a) => a.id === "check-error" && /key exploded/.test(a.reasoning)),
    ).toBe(true);
  });

  it("truncates the violating-key list past five keys", async () => {
    currentObservations = [];
    for (let i = 0; i < 7; i++) {
      currentObservations.push(
        toolObs("read_file", { path: `file-${i}.txt` }),
        toolObs("read_file", { path: `file-${i}.txt` }),
      );
    }
    const result = await runOneCheck((t) => {
      t.maxToolCallsPer(1, "read_file", pathKey, { keyLabel: "path" });
    });
    expect(result.pass).toBe(false);
    const received = JSON.stringify(result.assertions.map((a) => a.received));
    expect(received).toContain("...");
  });
});

describe("everyToolCall", () => {
  const arithmetic = (call: { input?: unknown }) =>
    /^[\d\s+\-*/().]+$/.test(
      String((call.input as { expression?: string } | undefined)?.expression ?? ""),
    );

  it("passes when all matching calls satisfy the predicate", async () => {
    currentObservations = [
      toolObs("compute", { expression: "1 + 1" }),
      toolObs("compute", { expression: "3588.00 * 12" }),
    ];
    const result = await runOneCheck((t) => {
      t.everyToolCall("compute", arithmetic, { label: "expressions are arithmetic" });
    });
    expect(result.pass).toBe(true);
  });

  it("fails and summarizes the offending call", async () => {
    currentObservations = [
      toolObs("compute", { expression: "1 + 1" }),
      toolObs("compute", { expression: "os.system('rm -rf /')" }),
    ];
    const result = await runOneCheck((t) => {
      t.everyToolCall("compute", arithmetic);
    });
    expect(result.pass).toBe(false);
    const payload = JSON.stringify(result.assertions);
    expect(payload).toContain("1 of 2");
    expect(payload).toContain("os.system");
  });

  it("fails on zero matching calls: vacuous truth is not a verdict", async () => {
    currentObservations = [toolObs("read_file", { path: "a.txt" })];
    const result = await runOneCheck((t) => {
      t.everyToolCall("compute", arithmetic);
    });
    expect(result.pass).toBe(false);
    const payload = JSON.stringify(result.assertions).toLowerCase();
    expect(payload).toContain("no ");
  });

  it("is unsupported without the tools capability", async () => {
    resetFlowChecks();
    defineCheck("no-tools", (t) => {
      t.everyToolCall("compute", arithmetic);
    });
    const snap = snapshot([toolObs("compute", { expression: "1" })], {
      tools: "unavailable",
    });
    const results = await runTraceChecks({ snapshot: snap, deliverables: {} });
    expect(results[0]!.pass).toBe(false);
    const outcomes = results[0]!.assertions.map((a) => a.outcome).join(",");
    expect(outcomes).toContain("unsupported");
  });

  it("surfaces a throwing predicate as a check error, never a pass", async () => {
    currentObservations = [toolObs("compute", { expression: "1 + 1" })];
    const result = await runOneCheck((t) => {
      t.everyToolCall("compute", () => {
        throw new Error("predicate exploded");
      });
    });
    expect(result.pass).toBe(false);
    expect(
      result.assertions.some((a) => a.id === "check-error" && /predicate exploded/.test(a.reasoning)),
    ).toBe(true);
  });

  it("scopes to the post-steer window inside t.afterSteer", async () => {
    resetFlowChecks();
    defineCheck("windowed", (t) => {
      t.afterSteer(1, (t2) => {
        // Before the steer: a compute call that violates arithmetic. The
        // windowed view must not see it.
        t2.everyToolCall("compute", (call) =>
          /^[\d\s+\-*/().]+$/.test(
            String((call.input as { expression?: string } | undefined)?.expression ?? ""),
          ),
        );
      });
    });
    const steerObs = {
      spanId: "steer-1",
      type: "CHAIN" as const,
      name: "task.steer",
      status: "unset" as const,
      startedAt: "2026-07-10T10:00:02Z",
      output: { number: 1 },
    };
    const before = toolObs("compute", { expression: "eval('nope')" }, { startedAt: "2026-07-10T10:00:01Z" });
    const after = toolObs("compute", { expression: "2 + 2" }, { startedAt: "2026-07-10T10:00:03Z" });
    const results = await runTraceChecks({
      snapshot: snapshot([before, steerObs, after]),
      deliverables: {},
    });
    expect(results[0]!.pass).toBe(true);
  });
});
