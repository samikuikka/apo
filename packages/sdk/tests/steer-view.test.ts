import { describe, expect, it } from "vitest";
import { TraceView } from "../src/agent-task/trace-projection/view.ts";
import type {
  TraceProjectionSnapshot,
  TraceProjectionObservation,
  TraceProjectionCapabilities,
} from "../src/agent-task/trace-projection/types.ts";
import { createTraceTestContext } from "../src/agent-task/checks/t.ts";
import { Recorder } from "../src/agent-task/checks/recorder.ts";

function allAvailable(): TraceProjectionCapabilities {
  return {
    messages: "available",
    tools: "available",
    errors: "available",
    timing: "available",
    skills: "available",
    subagents: "available",
  };
}

function snapshot(
  observations: TraceProjectionObservation[],
): TraceProjectionSnapshot {
  return {
    schemaVersion: 1,
    projectionVersion: 1,
    source: "canonical",
    trace: { traceId: "t1", complete: true },
    capabilities: allAvailable(),
    observations,
  };
}

let idCounter = 0;
/** Monotonic tee-style ids: root-000001, root-000002, … (creation order). */
function nextId(): string {
  idCounter += 1;
  return `root-${String(idCounter).padStart(6, "0")}`;
}

/** Timestamps share one epoch and advance one ms per observation. */
let clock = 0;
function nextTs(): string {
  clock += 1;
  return `1970-01-01T00:00:${String(clock).padStart(2, "0")}.000Z`;
}

function genObs(text: string): TraceProjectionObservation {
  return {
    spanId: nextId(),
    type: "GENERATION",
    name: "model-call",
    startedAt: nextTs(),
    endedAt: nextTs(),
    status: "ok",
    messages: [{ role: "assistant", content: text }],
  };
}

function toolObs(name: string): TraceProjectionObservation {
  return {
    spanId: nextId(),
    type: "TOOL",
    name: `tool ${name}`,
    toolName: name,
    startedAt: nextTs(),
    endedAt: nextTs(),
    status: "ok",
  };
}

function steerObs(record: Record<string, unknown>): TraceProjectionObservation {
  return {
    spanId: nextId(),
    type: "CHAIN",
    name: "task.steer",
    startedAt: nextTs(),
    endedAt: nextTs(),
    status: "ok",
    output: { ...record },
  };
}

function makeT(observations: TraceProjectionObservation[]) {
  const view = new TraceView(snapshot(observations));
  const rec = new Recorder();
  const t = createTraceTestContext(view, rec);
  return { view, rec, t };
}

function resetFixture(): void {
  idCounter = 0;
  clock = 0;
}

describe("TraceView steering evidence", () => {
  it("exposes steers parsed from task.steer observations, in number order", () => {
    resetFixture();
    const { view } = makeT([
      genObs("first answer"),
      steerObs({
        number: 1,
        turn: 1,
        label: "exclude-cancelled",
        trigger: '{"toolResults":2}',
        message: "exclude cancelled orders",
        status: "delivered",
        deliveredAt: "2026-10-04T10:00:00.000Z",
        boundary: "tool_results",
      }),
      genObs("done, cancelled excluded"),
    ]);

    expect(view.steers).toHaveLength(1);
    const steer = view.steers[0]!;
    expect(steer.number).toBe(1);
    expect(steer.label).toBe("exclude-cancelled");
    expect(steer.status).toBe("delivered");
    expect(steer.boundary).toBe("tool_results");
    expect(steer.spanStartedAt).toBeDefined();
    expect(steer.spanId).toMatch(/^root-/);
  });

  it("windowAfterSteer keeps only post-steer observations", () => {
    resetFixture();
    const before = genObs("thinking out loud");
    const toolBefore = toolObs("read_file");
    const steer = steerObs({
      number: 1,
      turn: 1,
      status: "delivered",
      message: "correction",
    });
    const toolAfter = toolObs("search_content");
    const after = genObs("corrected answer");

    const { view } = makeT([before, toolBefore, steer, toolAfter, after]);
    const window = view.windowAfterSteer(1);

    const names = window.toolNamesInOrder;
    expect(names).toEqual(["search_content"]); // read_file predates the steer
    expect(window.reply).toBe("corrected answer");
  });

  it("windowAfterSteer throws for an unknown steer number", () => {
    resetFixture();
    const { view } = makeT([genObs("x")]);
    expect(() => view.windowAfterSteer(7)).toThrow(/no steer number 7/i);
  });

  it("windowAfterSteer is empty for an undelivered steer", () => {
    resetFixture();
    const steer = steerObs({ number: 1, turn: 1, status: "undelivered", message: "m" });
    const { view } = makeT([steer, genObs("later")]);
    expect(view.windowAfterSteer(1).toolCalls).toHaveLength(0);
  });

  it("same-millisecond delivery still orders by span id (tie-break)", () => {
    resetFixture();
    const steer = steerObs({ number: 1, turn: 1, status: "delivered", message: "m" });
    const gen = genObs("consumed it");
    // Force identical timestamps — the ids must break the tie.
    gen.startedAt = steer.startedAt;
    const { view } = makeT([steer, gen]);
    expect(view.windowAfterSteer(1).reply).toBe("consumed it");
  });

  it("parses the canonical backend output shape (record JSON inside text/messages)", () => {
    resetFixture();
    // Exact shape observed from the live backend projection: recordEvent
    // output exports as gen_ai.response.text + gen_ai.output.messages, so
    // the SteerRecord arrives JSON-stringified inside an assistant message.
    const record = {
      number: 1,
      turn: 1,
      label: "exclude-cancelled",
      trigger: '{"toolResults":2}',
      message: "Correction: exclude cancelled orders.",
      status: "delivered",
      deliveredAt: "2026-10-04T10:06:46.777Z",
      boundary: "tool_results",
    };
    const recordJson = JSON.stringify(record);
    const obs: TraceProjectionObservation = {
      spanId: nextId(),
      type: "CHAIN",
      name: "task.steer",
      startedAt: "2026-10-04T10:06:46.777000+00:00",
      endedAt: "2026-10-04T10:06:46.777000+00:00",
      durationMs: 0,
      status: "ok",
      output: {
        messages: [{ role: "assistant", content: recordJson }],
        text: recordJson,
      },
    };

    const { view, rec, t } = makeT([obs, { ...genObs("reacted"), startedAt: "2026-10-04T10:06:48.000000+00:00" }]);

    const steer = view.steers[0]!;
    expect(steer.label).toBe("exclude-cancelled");
    expect(steer.status).toBe("delivered");
    expect(steer.boundary).toBe("tool_results");

    t.steerDelivered(1);
    expect(rec.all[0]?.pass).toBe(true);
  });
});

describe("t.steerDelivered", () => {
  it("passes when a generation consumed the steer", () => {
    resetFixture();
    const { rec, t } = makeT([
      genObs("working"),
      steerObs({ number: 1, turn: 1, status: "delivered", message: "m" }),
      genObs("reacted"),
    ]);
    t.steerDelivered(1);
    expect(rec.all).toHaveLength(1);
    expect(rec.all[0]?.pass).toBe(true);
  });

  it("fails when no generation started after the steer", () => {
    resetFixture();
    const { rec, t } = makeT([
      steerObs({ number: 1, turn: 1, status: "delivered", message: "m" }),
    ]);
    t.steerDelivered(1);
    expect(rec.all[0]?.pass).toBe(false);
    expect(rec.all[0]?.reasoning).toMatch(/no generation observation started after/);
  });

  it("fails closed with no steering evidence at all", () => {
    resetFixture();
    const { rec, t } = makeT([genObs("plain run")]);
    t.steerDelivered(1);
    expect(rec.all[0]?.pass).toBe(false);
    expect(rec.all[0]?.reasoning).toMatch(/steering evidence unavailable/);
  });

  it("fails with the reason when the steer was undelivered or errored", () => {
    resetFixture();
    const { rec, t } = makeT([
      steerObs({
        number: 1,
        turn: 1,
        status: "undelivered",
        reason: "turn ended before trigger fired",
        message: "m",
      }),
    ]);
    t.steerDelivered(1);
    expect(rec.all[0]?.pass).toBe(false);
    expect(rec.all[0]?.reasoning).toContain("turn ended before trigger fired");
  });

  it("fails for an unknown steer number", () => {
    resetFixture();
    const { rec, t } = makeT([
      steerObs({ number: 1, turn: 1, status: "delivered", message: "m" }),
      genObs("r"),
    ]);
    t.steerDelivered(2);
    expect(rec.all[0]?.pass).toBe(false);
    expect(rec.all[0]?.reasoning).toMatch(/no steer number 2/);
  });
});

describe("t.afterSteer", () => {
  it("scopes calledTool to the post-steer window", () => {
    resetFixture();
    const { rec, t } = makeT([
      toolObs("read_file"),
      steerObs({ number: 1, turn: 1, status: "delivered", message: "m" }),
      toolObs("search_content"),
      genObs("redid the work"),
    ]);

    t.afterSteer(1, (t2) => {
      t2.calledTool("read_file"); // BEFORE the steer — must not count
      t2.calledTool("search_content"); // after the steer — must count
    });

    const byId = Object.fromEntries(rec.all.map((r) => [r.id, r.pass]));
    expect(byId['calledTool("read_file")']).toBe(false);
    expect(byId['calledTool("search_content")']).toBe(true);
  });

  it("messageIncludes reads post-steer replies only", () => {
    resetFixture();
    const { rec, t } = makeT([
      genObs("i will include cancelled orders"),
      steerObs({ number: 1, turn: 1, status: "delivered", message: "m" }),
      genObs("excluded cancelled orders as instructed"),
    ]);
    t.afterSteer(1, (t2) => {
      t2.messageIncludes(/as instructed/);
    });
    expect(rec.all[0]?.pass).toBe(true);
  });

  it("records one failure and skips fn when no steering evidence exists", () => {
    resetFixture();
    const { rec, t } = makeT([genObs("plain")]);
    let ran = false;
    t.afterSteer(1, () => {
      ran = true;
    });
    expect(ran).toBe(false);
    expect(rec.all).toHaveLength(1);
    expect(rec.all[0]?.pass).toBe(false);
    expect(rec.all[0]?.reasoning).toMatch(/steering evidence unavailable/);
  });

  it("supports value assertions inside the window (same recorder)", () => {
    resetFixture();
    const { rec, t } = makeT([
      steerObs({ number: 1, turn: 1, status: "delivered", message: "m" }),
      genObs("after"),
    ]);
    t.afterSteer(1, (t2) => {
      t2.check(2, {
        test: (v) => v === 2,
        label: "be 2",
      } as never);
    });
    expect(rec.all[0]?.pass).toBe(true);
  });
});
