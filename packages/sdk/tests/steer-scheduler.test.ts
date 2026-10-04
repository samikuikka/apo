import { beforeEach, describe, expect, it } from "vitest";
import { createSteerScheduler } from "../src/agent-task/run/steer-scheduler.ts";
import type { SteerScheduler } from "../src/agent-task/run/steer-scheduler.ts";
import { createNoopAgentTaskTraceContext } from "../src/agent-task/tracing.ts";
import type { AdapterSession, SteerResult } from "../src/agent-task/adapter/types.ts";
import type { SteerRecord } from "../src/agent-task/run/types.ts";
import { resetTaskSteers, steer } from "../src/agent-task/steer.ts";

/**
 * A minimal session whose steer() the tests observe. sendUserTurn is never
 * called by the scheduler itself — the tests drive events by hand, the way
 * runTurnLoop would.
 */
function fakeSession(options: {
  onSteer?: (input: unknown, steerNumber: number) => Promise<SteerResult>;
} = {}): { session: AdapterSession; injections: Array<{ input: unknown; n: number }> } {
  const injections: Array<{ input: unknown; n: number }> = [];
  const session: AdapterSession = {
    sendUserTurn: async () => ({ response: "unused" }),
    steer: async (input, ctx) => {
      injections.push({ input, n: ctx.steerNumber });
      return (
        options.onSteer?.(input, ctx.steerNumber) ?? { boundary: "tool_results" }
      );
    },
  };
  return { session, injections };
}

function makeScheduler(
  session: AdapterSession,
  specs: Parameters<typeof createSteerScheduler>[0]["specs"],
  onSteer?: (record: SteerRecord) => void,
): SteerScheduler {
  return createSteerScheduler({
    specs,
    session,
    trace: createNoopAgentTaskTraceContext(),
    onSteer,
  });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("steer scheduler", () => {
  beforeEach(() => resetTaskSteers());

  it("delivers a toolResults steer mid-turn, after the n-th tool result", async () => {
    const { session, injections } = fakeSession();
    const scheduler = makeScheduler(session, [
      { when: { toolResults: 2 }, message: "stop", label: "correct" },
    ]);
    const onSteerRecords: SteerRecord[] = [];

    await scheduler.onTurnStart(1);
    expect(injections).toHaveLength(0); // nothing fires on turn start alone
    await scheduler.onProgressEvent(1, { kind: "run_start" });
    await scheduler.onProgressEvent(1, { kind: "tool_result", toolName: "read" });
    expect(injections).toHaveLength(0); // 1 tool result — not yet
    await scheduler.onProgressEvent(1, { kind: "tool_result", toolName: "grep" });
    expect(injections).toEqual([{ input: "stop", n: 1 }]); // exactly after the 2nd
    await scheduler.onProgressEvent(1, { kind: "tool_result", toolName: "read" });
    expect(injections).toHaveLength(1); // at most once per run
    await scheduler.onTurnEnd(1);

    const records = scheduler.recordsByTurn().get(1) ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("delivered");
    expect(records[0]?.boundary).toBe("tool_results");
    expect(records[0]?.deliveredAt).toBeDefined();
    void onSteerRecords;
  });

  it("fires runStart steers on the adapter's run_start event", async () => {
    const { session, injections } = fakeSession({
      onSteer: async () => ({ boundary: "run_start" }),
    });
    const scheduler = makeScheduler(session, [{ when: "runStart", message: "early" }]);

    await scheduler.onTurnStart(1);
    expect(injections).toHaveLength(0); // not before the harness has a run
    await scheduler.onProgressEvent(1, { kind: "run_start" });
    expect(injections).toEqual([{ input: "early", n: 1 }]);
    await scheduler.onTurnEnd(1);

    const [record] = scheduler.recordsByTurn().get(1) ?? [];
    expect(record?.status).toBe("delivered");
    expect(record?.boundary).toBe("run_start");
  });

  it("fires assistantReply steers after the n-th assistant reply", async () => {
    const { session, injections } = fakeSession();
    const scheduler = makeScheduler(session, [
      { when: { assistantReply: 2 }, message: "redirect" },
    ]);

    await scheduler.onTurnStart(1);
    await scheduler.onProgressEvent(1, { kind: "assistant_reply" });
    expect(injections).toHaveLength(0);
    await scheduler.onProgressEvent(1, { kind: "assistant_reply" });
    expect(injections).toEqual([{ input: "redirect", n: 1 }]);
    await scheduler.onTurnEnd(1);
  });

  it("marks un-fired steers undelivered when the turn ends, without failing", async () => {
    const { session } = fakeSession();
    const scheduler = makeScheduler(session, [{ when: { toolResults: 5 }, message: "late" }]);

    await scheduler.onTurnStart(1);
    await scheduler.onProgressEvent(1, { kind: "run_start" });
    await scheduler.onProgressEvent(1, { kind: "tool_result" });
    await scheduler.onProgressEvent(1, { kind: "tool_result" });
    await scheduler.onTurnEnd(1);

    const [record] = scheduler.recordsByTurn().get(1) ?? [];
    expect(record?.status).toBe("undelivered");
    expect(record?.reason).toBe("turn ended before trigger fired");
  });

  it("diagnoses an adapter that never reported progress", async () => {
    const { session } = fakeSession();
    const scheduler = makeScheduler(session, [{ when: { toolResults: 2 }, message: "x" }]);

    await scheduler.onTurnStart(1);
    // No notifyAgentEvent calls at all — the adapter ignores the contract.
    await scheduler.onTurnEnd(1);

    const [record] = scheduler.recordsByTurn().get(1) ?? [];
    expect(record?.status).toBe("undelivered");
    expect(record?.reason).toMatch(/no progress events observed/);
  });

  it("records a rejected injection as status=error, not a throw", async () => {
    const { session } = fakeSession({
      onSteer: async () => {
        throw new Error("queue full");
      },
    });
    const scheduler = makeScheduler(session, [{ when: "runStart", message: "boom" }]);

    await scheduler.onTurnStart(1);
    await expect(
      scheduler.onProgressEvent(1, { kind: "run_start" }),
    ).resolves.toBeUndefined();
    await scheduler.onTurnEnd(1);

    const [record] = scheduler.recordsByTurn().get(1) ?? [];
    expect(record?.status).toBe("error");
    expect(record?.reason).toBe("queue full");
  });

  it("delivers same-boundary steers in registration order", async () => {
    const { session, injections } = fakeSession();
    const scheduler = makeScheduler(session, [
      { when: { toolResults: 1 }, message: "first" },
      { when: { toolResults: 1 }, message: "second" },
    ]);

    await scheduler.onTurnStart(1);
    await scheduler.onProgressEvent(1, { kind: "run_start" });
    await scheduler.onProgressEvent(1, { kind: "tool_result" });
    await scheduler.onTurnEnd(1);

    expect(injections.map((i) => i.input)).toEqual(["first", "second"]);
  });

  it("marks steers for a turn that never ran", async () => {
    const { session } = fakeSession();
    const scheduler = makeScheduler(session, [
      { when: "runStart", message: "a" },
      { when: "runStart", message: "b", turn: 3 },
    ]);

    await scheduler.onTurnStart(1);
    await scheduler.onProgressEvent(1, { kind: "run_start" });
    await scheduler.onTurnEnd(1);
    await scheduler.onRunEnd(1); // only turn 1 ran

    const records = [...scheduler.recordsByTurn().values()].flat();
    expect(records.find((r) => r.number === 1)?.status).toBe("delivered");
    const skipped = records.find((r) => r.number === 2);
    expect(skipped?.status).toBe("undelivered");
    expect(skipped?.reason).toBe("target turn never ran");
  });

  it("ignores progress events for turns that already ended", async () => {
    const { session, injections } = fakeSession();
    const scheduler = makeScheduler(session, [{ when: { toolResults: 1 }, message: "late" }]);

    await scheduler.onTurnStart(1);
    await scheduler.onTurnEnd(1);
    await scheduler.onProgressEvent(1, { kind: "tool_result" });

    expect(injections).toHaveLength(0);
    const [record] = scheduler.recordsByTurn().get(1) ?? [];
    expect(record?.status).toBe("undelivered");
  });

  it("thread-1 steer counters are independent of other turns", async () => {
    const { session, injections } = fakeSession();
    const scheduler = makeScheduler(session, [
      { when: { toolResults: 1 }, message: "t1", turn: 1 },
      { when: { toolResults: 1 }, message: "t2", turn: 2 },
    ]);

    await scheduler.onTurnStart(1);
    await scheduler.onProgressEvent(1, { kind: "tool_result" });
    await scheduler.onTurnEnd(1);
    expect(injections.map((i) => i.input)).toEqual(["t1"]);

    await scheduler.onTurnStart(2);
    await scheduler.onProgressEvent(2, { kind: "tool_result" });
    await scheduler.onTurnEnd(2);
    expect(injections.map((i) => i.input)).toEqual(["t1", "t2"]);
  });

  it("serializes: an in-flight delivery completes before the next event is processed", async () => {
    const order: string[] = [];
    const { session } = fakeSession({
      onSteer: async () => {
        order.push("steer:start");
        await tick();
        order.push("steer:end");
        return { boundary: "tool_results" };
      },
    });
    const scheduler = makeScheduler(session, [{ when: { toolResults: 1 }, message: "slow" }]);

    await scheduler.onTurnStart(1);
    // Do NOT await — the runner fires events without waiting on the scheduler.
    const p1 = scheduler.onProgressEvent(1, { kind: "tool_result" });
    const p2 = scheduler.onProgressEvent(1, { kind: "assistant_reply" });
    await Promise.all([p1, p2]);
    await scheduler.onTurnEnd(1);

    // The steer's start/end pair is contiguous: the assistant_reply event's
    // processing waited for the delivery chain, it did not interleave.
    expect(order).toEqual(["steer:start", "steer:end"]);
  });

  it("onSteer reports every outcome exactly once", async () => {
    const { session } = fakeSession();
    const seen: SteerRecord[] = [];
    const scheduler = makeScheduler(
      session,
      [
        { when: "runStart", message: "delivered-one" },
        { when: { toolResults: 9 }, message: "never" },
      ],
      (record) => seen.push(record),
    );

    await scheduler.onTurnStart(1);
    await scheduler.onProgressEvent(1, { kind: "run_start" });
    await scheduler.onTurnEnd(1);

    expect(seen.map((r) => r.status)).toEqual(["delivered", "undelivered"]);
  });

  it("task-plane steer() registrations feed the scheduler unchanged", async () => {
    const { session, injections } = fakeSession();
    steer({ when: { toolResults: 1 }, message: "from-registry" });
    const scheduler = makeScheduler(session, [
      // The runner passes getTaskSteers() output here; simulate that.
      ...(await import("../src/agent-task/steer.ts")).getTaskSteers(),
    ]);

    await scheduler.onTurnStart(1);
    await scheduler.onProgressEvent(1, { kind: "tool_result" });
    await scheduler.onTurnEnd(1);

    expect(injections.map((i) => i.input)).toEqual(["from-registry"]);
  });
});
