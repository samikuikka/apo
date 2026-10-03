/**
 * Issue #161 parts 1–3: let tasks brief the judge.
 *
 * 1. Thread a JudgeContext (task id/description, check name, instruction,
 *    deliverable names) to the judge call site.
 * 2. Task-level judge layer — `run-level ← task-level ← per-call` config
 *    resolution via `judge` on the TaskDefinition.
 * 3. `prompt` builder on JudgeConfig that customizes the *briefing* only;
 *    the SDK keeps ownership of the JSON response contract and
 *    `response_format`, so a builder cannot break parsing.
 *
 * Compatibility invariant under test: with no builder set anywhere, the
 * assembled prompt is byte-for-byte today's prompt.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { basename, join } from "path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import {
  defineCheck,
  resetFlowChecks,
  runTraceChecks,
} from "../src/agent-task/checks/flow-runner.ts";
import { callJudge } from "../src/agent-task/checks/judge.ts";
import { resolveJudgeConfig } from "../src/agent-task/checks/t.ts";
import { runTask } from "../src/agent-task/run/runTask.ts";
import type { TraceProjectionSnapshot } from "../src/agent-task/trace-projection/types.ts";

const emptySnapshot: TraceProjectionSnapshot = {
  schemaVersion: 1,
  projectionVersion: 1,
  source: "local",
  trace: { traceId: "test", complete: true },
  capabilities: {
    messages: "unavailable",
    tools: "unavailable",
    errors: "available",
    timing: "available",
    skills: "unavailable",
    subagents: "unavailable",
  },
  observations: [],
};

const DEFAULT_SYSTEM_PROMPT =
  "You are an evaluation judge. Evaluate the given value(s) against the " +
  'instruction. Respond with ONLY a JSON object: {"reasoning": "your reasoning", "pass": true/false}';

const RESPONSE_CONTRACT =
  'Respond with ONLY a JSON object: {"reasoning": "your reasoning", "pass": true/false}';

const judgeConfig = {
  model: "test/judge",
  baseURL: "https://judge.test/v1",
  apiKey: "secret",
};

const demoTask = {
  id: "due-diligence",
  description: "Draft a due-diligence memo from the data room.",
  adapter: "demo",
  deliverables: ["memo"],
};

afterEach(() => {
  vi.unstubAllGlobals();
  resetFlowChecks();
});

function stubCapturingJudge(content = JSON.stringify({ pass: true, reasoning: "ok" })): vi.Mock {
  const fetchMock = vi.fn(async () =>
    Response.json({ choices: [{ message: { content } }] }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestBody(fetchMock: vi.Mock, call = 0): {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  response_format?: { type: string };
} {
  return JSON.parse(fetchMock.mock.calls[call]![1]!.body as string);
}

function systemBlocks(body: { messages: Array<{ role: string; content: unknown }> }): Array<{
  type: string;
  text: string;
  cache_control?: { type: string };
}> {
  const system = body.messages.find((m) => m.role === "system")!;
  return system.content as Array<{ type: string; text: string; cache_control?: { type: string } }>;
}

function userText(body: { messages: Array<{ role: string; content: unknown }> }): string {
  const user = body.messages.find((m) => m.role === "user")!;
  return typeof user.content === "string" ? user.content : JSON.stringify(user.content);
}

describe("t.judge default prompt compatibility (issue #161)", () => {
  it("keeps today's prompt byte-for-byte when no builder is configured", async () => {
    const fetchMock = stubCapturingJudge();
    defineCheck("quality", async (t) => {
      await t.judge("memo body", "PASS when correct");
    });

    await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      task: demoTask,
      judgeConfig,
    });

    const body = requestBody(fetchMock);
    const blocks = systemBlocks(body);

    // Exactly two system blocks: fixed briefing + cached deliverable.
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(blocks[0]!.cache_control).toBeUndefined();
    expect(blocks[1]!.text).toBe("Values to evaluate:\nmemo body");
    expect(blocks[1]!.cache_control).toEqual({ type: "ephemeral" });
    expect(userText(body)).toBe("Instruction:\nPASS when correct");
  });

  it("ignores an empty builder result and keeps the default prompt", async () => {
    const fetchMock = stubCapturingJudge();
    defineCheck("quality", async (t) => {
      await t.judge("memo body", "PASS when correct", {
        judge: { prompt: () => ({}) },
      });
    });

    await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      task: demoTask,
      judgeConfig,
    });

    expect(systemBlocks(requestBody(fetchMock))[0]!.text).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});

describe("t.judge context threading (issue #161 part 1)", () => {
  it("hands the builder the full judge context: task, check, instruction, deliverables", async () => {
    stubCapturingJudge();
    const seen: unknown[] = [];
    defineCheck("figures-accurate", async (t, { deliverables }) => {
      const memo = (deliverables as Record<string, unknown>).memo;
      await t.judge(memo, "PASS when figures are exact", {
        judge: {
          prompt: (ctx) => {
            seen.push(ctx);
            return { system: "briefing" };
          },
        },
      });
    });

    await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: { memo: "the memo", stats: { calls: 3 } },
      task: demoTask,
      judgeConfig,
    });

    expect(seen).toEqual([
      {
        taskId: "due-diligence",
        taskDescription: "Draft a due-diligence memo from the data room.",
        checkName: "figures-accurate",
        instruction: "PASS when figures are exact",
        deliverableNames: ["memo"],
      },
    ]);
  });

  it("tracks only the deliverables the check actually read", async () => {
    stubCapturingJudge();
    const names: string[][] = [];
    defineCheck("stats-only", async (t, { deliverables }) => {
      const d = deliverables as Record<string, unknown>;
      void d.memo;
      const stats = d.stats as { calls: number };
      await t.judge(stats, "PASS when sane", {
        judge: {
          prompt: (ctx) => {
            names.push(ctx.deliverableNames ?? []);
            return {};
          },
        },
      });
    });

    await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: { memo: "m", stats: { calls: 1 }, log: "l" },
      task: demoTask,
      judgeConfig,
    });

    // `memo` was read for context, `stats` is what's judged, `log` untouched.
    expect(names).toEqual([["memo", "stats"]]);
  });

  it("omits optional context fields the task does not provide", async () => {
    stubCapturingJudge();
    const seen: unknown[] = [];
    defineCheck("quality", async (t) => {
      await t.judge("value", "PASS when correct", {
        judge: {
          prompt: (ctx) => {
            seen.push(ctx);
            return {};
          },
        },
      });
    });

    await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      // A task without id/description shape — nothing to brief from.
      task: {},
      judgeConfig,
    });

    expect(seen).toEqual([
      { taskId: "", checkName: "quality", instruction: "PASS when correct" },
    ]);
  });
});

describe("t.judge prompt builder assembly (issue #161 part 3)", () => {
  it("replaces the briefing but keeps the SDK-owned response contract", async () => {
    const fetchMock = stubCapturingJudge();
    defineCheck("quality", async (t) => {
      await t.judge("memo body", "PASS when correct", {
        judge: {
          prompt: () => ({
            system:
              `You are grading a due-diligence memo. Read the rubric's FAIL ` +
              `clause as scoped to what it names; parentheticals are locators, ` +
              `not extra requirements.`,
          }),
        },
      });
    });

    await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      task: demoTask,
      judgeConfig,
    });

    const briefing = systemBlocks(requestBody(fetchMock))[0]!.text;
    expect(briefing).toContain("grading a due-diligence memo");
    // The SDK appends its response contract — a builder cannot drop it.
    expect(briefing.endsWith(RESPONSE_CONTRACT)).toBe(true);
    // response_format stays the SDK's.
    expect(requestBody(fetchMock).response_format).toEqual({ type: "json_object" });
  });

  it("lets the builder replace the user message (per-criterion text)", async () => {
    const fetchMock = stubCapturingJudge();
    defineCheck("figures", async (t) => {
      await t.judge("memo body", "PASS when figures are exact", {
        judge: {
          prompt: (ctx) => ({
            user: `Check "${ctx.checkName}":\n${ctx.instruction}`,
          }),
        },
      });
    });

    await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      task: demoTask,
      judgeConfig,
    });

    expect(userText(requestBody(fetchMock))).toBe(
      'Check "figures":\nPASS when figures are exact',
    );
    // System briefing untouched when the builder returns no system.
    expect(systemBlocks(requestBody(fetchMock))[0]!.text).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it("does not collide cache keys when the builder system varies per check", async () => {
    // Regression for the cache-correctness warning in #161: the cache key
    // must include the resolved system text, or two prompts grading one
    // deliverable would share a prefix queue key (and worse, a provider
    // cache entry) despite different briefings.
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount += 1;
        if (fetchCount === 1) await gate;
        return Response.json({
          choices: [{ message: { content: '{"pass":true,"reasoning":"ok"}' } }],
        });
      }),
    );

    defineCheck("criterion-a", async (t) => {
      await t.judge("shared deliverable", "a", {
        judge: { prompt: () => ({ system: "briefing for A" }) },
      });
    });
    defineCheck("criterion-b", async (t) => {
      await t.judge("shared deliverable", "b", {
        judge: { prompt: () => ({ system: "briefing for B" }) },
      });
    });

    const running = runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      task: demoTask,
      judgeConfig,
    });
    await flush();
    await flush();

    // Different briefings => different cache keys => concurrent dispatch,
    // not falsely serialized behind the gated first call.
    expect(fetchCount).toBe(2);

    release();
    const results = await running;
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.pass)).toBe(true);
  });

  it("serializes same-prefix judge calls even when a builder is set", async () => {
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount += 1;
        if (fetchCount === 1) await gate;
        return Response.json({
          choices: [{ message: { content: '{"pass":true,"reasoning":"ok"}' } }],
        });
      }),
    );

    // One shared briefing (constant per task, like taskDescription-based
    // briefings): same deliverable + same system => one prefix queue.
    defineCheck("criterion-a", async (t) => {
      await t.judge("shared deliverable", "a", {
        judge: { prompt: () => ({ system: "shared briefing" }) },
      });
    });
    defineCheck("criterion-b", async (t) => {
      await t.judge("shared deliverable", "b", {
        judge: { prompt: () => ({ system: "shared briefing" }) },
      });
    });

    const running = runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      task: demoTask,
      judgeConfig,
    });
    await flush();
    await flush();

    expect(fetchCount).toBe(1);

    release();
    const results = await running;
    expect(results.every((r) => r.pass)).toBe(true);
    expect(fetchCount).toBe(2);
  });

  it("records the assembled prompt in judge metadata for builders", async () => {
    stubCapturingJudge();
    defineCheck("quality", async (t) => {
      await t.judge("payload", "PASS when correct", {
        judge: {
          prompt: (ctx) => ({
            system: `Grading task ${ctx.taskId}`,
            user: `Check ${ctx.checkName}: ${ctx.instruction}`,
          }),
        },
      });
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      task: demoTask,
      judgeConfig,
    });

    expect(result?.judge?.prompt?.system).toContain("Grading task due-diligence");
    expect(result?.judge?.prompt?.system).toContain("payload");
    expect(result?.judge?.prompt?.user).toBe("Check quality: PASS when correct");
  });
});

describe("judge config layering (issue #161 part 2)", () => {
  it("resolves run-level ← task-level ← per-call with per-field precedence", () => {
    const run = { model: "run/model", baseURL: "https://run.test" };
    const taskLevel = { model: "task/model", prompt: () => ({}) };

    // Task-level beats run-level; unspecified fields inherit.
    const taskOverRun = resolveJudgeConfig(run, taskLevel);
    expect(taskOverRun?.model).toBe("task/model");
    expect(taskOverRun?.baseURL).toBe("https://run.test");
    expect(typeof taskOverRun?.prompt).toBe("function");

    // Per-call beats task-level.
    const callOverTask = resolveJudgeConfig(taskOverRun, { model: "call/model" });
    expect(callOverTask?.model).toBe("call/model");
    expect(callOverTask?.baseURL).toBe("https://run.test");
    expect(typeof callOverTask?.prompt).toBe("function");

    // Run-level alone still resolves.
    expect(resolveJudgeConfig(run, undefined)?.model).toBe("run/model");
    // Nothing set anywhere => no judge.
    expect(resolveJudgeConfig(undefined, { baseURL: "https://x.test" })).toBeUndefined();
  });
});

describe("task-level judge config through runTask (issue #161 part 2)", () => {
  const TMP_ROOT = join(import.meta.dirname, "__judge_context_test__");
  let taskDir = "";
  const LOCAL_DEFINE_ADAPTER_IMPORT = "../../../src/agent-task/adapter/defineAdapter";
  const LOCAL_PUBLIC_IMPORT = "../../../src/agent-task/public";

  beforeEach(() => {
    if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
    taskDir = join(TMP_ROOT, `case-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, `${basename(taskDir)}.eval.ts`), `
import { task } from "${LOCAL_PUBLIC_IMPORT}";
import { demoAdapter } from "./adapter.ts";

const { test: check } = task("judge-briefing-demo", {
  adapter: demoAdapter,
  description: "Demo task exercising the task-level judge layer.",
  judge: {
    model: "task/judge-model",
    prompt: (ctx) => ({
      system: \`You are grading check '\${ctx.checkName}' of task '\${ctx.taskId}'.\`,
    }),
  },
  deliverables: ["report"],
});

check("report-quality", async (t, { deliverables }) => {
  await t.judge(
    (deliverables as { report: { body: string } }).report.body,
    "PASS when the report is good",
  );
});
`);
    writeFileSync(join(taskDir, "adapter.ts"), `
import { defineAdapter } from "${LOCAL_DEFINE_ADAPTER_IMPORT}";

export const demoAdapter = defineAdapter({
  name: "demo-adapter",
  deliverables: { report: null },
  turn: async ({ transcript }) => (transcript.length > 0 ? null : "go"),
  async startSession() {
    return { async sendUserTurn() { return { response: "done" }; } };
  },
  async collectDeliverables() {
    return { report: { body: "the report body" } };
  },
});
`);
  });

  afterAll(() => {
    if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  it("applies the task's judge model and briefing over the run-level config", async () => {
    const fetchMock = stubCapturingJudge();

    const result = await runTask(taskDir, {
      judge: { model: "run/judge-model", baseURL: "https://judge.test/v1", apiKey: "secret" },
    });

    expect(result.result.pass).toBe(true);
    const body = requestBody(fetchMock);
    // Task-level model wins over the run-level model.
    expect(body.model).toBe("task/judge-model");
    // Task-level briefing is assembled with the threaded context.
    const briefing = systemBlocks(body)[0]!.text;
    expect(briefing).toContain("grading check 'report-quality' of task 'judge-briefing-demo'");
    expect(briefing.endsWith(RESPONSE_CONTRACT)).toBe(true);
    // Run-level fields the task didn't set still inherit through.
    expect(fetchMock.mock.calls[0]![1]!.headers!.Authorization).toBe("Bearer secret");
  });

  it("still runs the judge from task-level config alone when the run sets none", async () => {
    const fetchMock = stubCapturingJudge();

    const result = await runTask(taskDir);

    expect(result.result.pass).toBe(true);
    expect(requestBody(fetchMock).model).toBe("task/judge-model");
  });
});

describe("callJudge context fallback", () => {
  it("passes a minimal context to a builder when no scope was threaded", async () => {
    const fetchMock = stubCapturingJudge();
    const seen: unknown[] = [];

    await callJudge({
      values: ["value"],
      instruction: "PASS when correct",
      model: "test/judge",
      prompt: (ctx) => {
        seen.push(ctx);
        return {};
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      { taskId: "", checkName: "", instruction: "PASS when correct" },
    ]);
  });
});
