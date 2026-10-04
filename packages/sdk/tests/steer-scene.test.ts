import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { basename, join } from "path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { runTask, AgentTaskRunError } from "../src/agent-task/run/runTask.ts";
import { resetTaskSteers } from "../src/agent-task/steer.ts";

const TMP_ROOT = join(import.meta.dirname, "__steer_scene_test__");
const LOCAL_ADAPTER_IMPORT = "../../../src/agent-task/adapter/defineAdapter";
const LOCAL_PUBLIC_IMPORT = "../../../src/agent-task/public";

// The fake harness writes its event log here so the tests can assert ordering
// across the adapter/runner boundary (the eval module is a separate module
// graph, so a module-local variable would not be visible to the test).
type SteerTestLog = string[];
function log(): SteerTestLog {
  const g = globalThis as Record<string, unknown>;
  return (g.__steerSceneLog as SteerTestLog) ?? [];
}

/**
 * A scripted steering-capable harness. One turn: run_start → 3 tool results
 * (each a traced tool span) → one generation span that "reacts" to whatever
 * was injected → response text. Steered messages land in the log with their
 * position, proving mid-turn delivery.
 */
const ADAPTER_CONTENT = `
import { defineAdapter } from "${LOCAL_ADAPTER_IMPORT}";

type SteerTestLog = string[];

export const steerSceneAdapter = defineAdapter({
  name: "steer-scene",
  deliverables: { result: null },

  async startSession() {
    const g = globalThis as Record<string, unknown>;
    const log: SteerTestLog = [];
    g.__steerSceneLog = log;
    const inbox: string[] = [];
    return {
      async sendUserTurn(turn: unknown, ctx) {
        log.push("turn:start");
        ctx.notifyAgentEvent({ kind: "run_start" });
        for (let i = 1; i <= 3; i++) {
          await ctx.trace.traceTool("read_file", { path: "orders-" + i }, async () => "data");
          ctx.notifyAgentEvent({ kind: "tool_result", toolName: "read_file" });
          // Give the scheduler's delivery chain a beat: the real runner fires
          // events fire-and-forget, so a yield here lets steers land between
          // tool boundaries the way a real streaming harness would.
          await new Promise((r) => setTimeout(r, 5));
        }
        ctx.trace.recordEvent({
          step_name: "model-call",
          observation_type: "GENERATION",
          output: { text: "acknowledged: " + inbox.join(" | ") + " — cancelled excluded" },
        });
        log.push("turn:end");
        return { response: "report ready (cancelled excluded)" };
      },
      async steer(input: unknown, ctx) {
        inbox.push(String(input));
        log.push("steer:" + ctx.steerNumber + ":" + String(input));
        return { boundary: "tool_results" };
      },
    };
  },
  async collectDeliverables() {
    return { result: "Report: total 8,000 — cancelled excluded" };
  },
});
`;

/** Same harness minus session.steer — for the negotiation test. */
const ADAPTER_NO_STEER_CONTENT = ADAPTER_CONTENT.replace(
  /async steer\(input: unknown, ctx\) \{[\s\S]*?\n      \},/,
  "",
);

function taskDirFor(name: string): string {
  return join(TMP_ROOT, name);
}

function setupTask(
  name: string,
  options: {
    adapterContent?: string;
    evalContent?: string;
    checksContent?: string;
  },
): string {
  const dir = taskDirFor(name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "adapter.ts"),
    options.adapterContent ?? ADAPTER_CONTENT,
  );
  writeFileSync(join(dir, `${basename(dir)}.eval.ts`), options.evalContent ?? "");
  if (options.checksContent) {
    writeFileSync(join(dir, "checks.ts"), options.checksContent);
  }
  return dir;
}

const STEERING_EVAL = `
import { task, test, turn, steer } from "${LOCAL_PUBLIC_IMPORT}";
import { steerSceneAdapter } from "./adapter.ts";

const { test: check } = task("steering-scene", {
  adapter: steerSceneAdapter,
  deliverables: ["result"],
  maxTurns: 2,
});

turn(async (ctx) => (ctx.transcript.length === 0 ? "build the report" : null));

steer({
  when: { toolResults: 2 },
  label: "exclude-cancelled",
  message: "exclude cancelled orders",
});

check("correction-was-delivered", (t) => {
  t.steerDelivered(1);
});

check("reacted-in-window", (t) => {
  t.afterSteer(1, (t2) => {
    t2.messageIncludes(/cancelled excluded/);
  });
});
`;

function checkResult(
  results: Awaited<ReturnType<typeof runTask>>,
  id: string,
) {
  const item = results.result.checks.find((c) => c.id === id);
  expect(item, `check "${id}" should exist`).toBeDefined();
  return item!;
}

describe("steering scene — runTask end to end", () => {
  beforeEach(() => {
    resetTaskSteers();
  });

  afterAll(() => {
    if (existsSync(TMP_ROOT)) {
      rmSync(TMP_ROOT, { recursive: true, force: true });
    }
  });

  it("delivers a mid-run steer and both steering checks pass", async () => {
    const dir = setupTask("happy-path", { evalContent: STEERING_EVAL });

    const result = await runTask(dir);

    expect(result.result.pass).toBe(true);
    expect(checkResult(result, "correction-was-delivered").pass).toBe(true);
    expect(checkResult(result, "reacted-in-window").pass).toBe(true);

    // Mid-run: the steer happened after turn:start and before turn:end.
    const entries = log();
    const startIndex = entries.indexOf("turn:start");
    const steerIndex = entries.findIndex((e) => e.startsWith("steer:1:"));
    const endIndex = entries.indexOf("turn:end");
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    expect(steerIndex).toBeGreaterThan(startIndex);
    expect(steerIndex).toBeLessThan(endIndex);
    expect(entries[steerIndex]).toContain("exclude cancelled orders");

    // The transcript carries the steer record on its turn.
    const turn = result.transcript.turns[0]!;
    expect(turn.steers).toHaveLength(1);
    expect(turn.steers?.[0]?.status).toBe("delivered");
    expect(turn.steers?.[0]?.label).toBe("exclude-cancelled");
    expect(turn.steers?.[0]?.boundary).toBe("tool_results");
  });

  it("fails closed before turn 1 when the adapter cannot steer", async () => {
    const dir = setupTask("no-steer-capability", {
      adapterContent: ADAPTER_NO_STEER_CONTENT,
      evalContent: STEERING_EVAL,
    });

    await expect(runTask(dir)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AgentTaskRunError);
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("steer-scene");
      expect(message).toContain("session.steer");
      return true;
    });
    // The turn never started.
    expect(log().includes("turn:start")).toBe(false);
  });

  it("supports legacy two-file tasks registering steer() in checks.ts", async () => {
    const dir = setupTask("legacy-two-file", {
      evalContent: `
import { defineTask } from "../../../src/agent-task/task/defineTask";
import { steerSceneAdapter } from "./adapter.ts";

export default defineTask(steerSceneAdapter, {
  id: "steering-legacy",
  deliverables: ["result"],
  checks: "checks.ts",
});
`,
      checksContent: `
import { test, turn, steer } from "${LOCAL_PUBLIC_IMPORT}";

turn(async (ctx) => (ctx.transcript.length === 0 ? "build the report" : null));

steer({ when: "runStart", message: "note: exclude cancelled orders" });

test("legacy-steer-delivered", (t) => {
  t.steerDelivered(1);
});
`,
    });

    const result = await runTask(dir);

    expect(result.result.pass).toBe(true);
    const steer = result.transcript.turns[0]?.steers?.[0];
    expect(steer?.status).toBe("delivered");
    expect(steer?.boundary).toBe("tool_results");
    expect(log().some((e) => e.startsWith("steer:1:"))).toBe(true);
  });

  it("a trigger that never fires yields an undelivered record and a failing check", async () => {
    const dir = setupTask("trigger-never-fires", {
      evalContent: `
import { task, test, turn, steer } from "${LOCAL_PUBLIC_IMPORT}";
import { steerSceneAdapter } from "./adapter.ts";

const { test: check } = task("steering-never", {
  adapter: steerSceneAdapter,
  deliverables: ["result"],
  maxTurns: 2,
});

turn(async (ctx) => (ctx.transcript.length === 0 ? "build" : null));

// The fake harness emits 3 tool results; this wants the 9th.
steer({ when: { toolResults: 9 }, message: "never lands" });

check("delivered-anyway", (t) => {
  t.steerDelivered(1);
});
`,
    });

    const result = await runTask(dir);

    expect(result.result.pass).toBe(false);
    const item = checkResult(result, "delivered-anyway");
    expect(item.pass).toBe(false);
    const turn = result.transcript.turns[0]!;
    expect(turn.steers?.[0]?.status).toBe("undelivered");
    expect(turn.steers?.[0]?.reason).toMatch(/turn ended before trigger fired/);
  });

  it("onSteer reports each outcome to the caller", async () => {
    const dir = setupTask("on-steer-callback", { evalContent: STEERING_EVAL });
    const seen: string[] = [];

    await runTask(dir, {
      onSteer: (record) => seen.push(`${record.number}:${record.status}`),
    });

    expect(seen).toEqual(["1:delivered"]);
  });
});
