/**
 * The evaluation phase span (issue #302): traced runs wrap the whole checks
 * execution in one `checks.run` CHAIN step so every judge span nests under it
 * instead of parenting to the trace root. Execution-phase steps (task.turn,
 * adapter work) must stay outside it — the span is the boundary between what
 * the agent under test did and what the evaluation did.
 *
 * The fake client below records each step() call together with the stack of
 * step names active when it started, which makes nesting assertions direct.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { basename, join } from "path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { runTask } from "../src/agent-task/run/runTask";
import type { TraceStepOptions } from "../src/types.ts";

const TMP_ROOT = join(import.meta.dirname, "__checks_run_span_test__");
// Fresh dir per test: import() caches by path, so rewriting checks.ts in the
// same dir would silently re-run the previous test's module.
let taskDir = "";
const LOCAL_DEFINE_TASK_IMPORT = "../../../src/agent-task/task/defineTask";
const LOCAL_DEFINE_ADAPTER_IMPORT = "../../../src/agent-task/adapter/defineAdapter";
const LOCAL_CHECKS_IMPORT = "../../../src/agent-task/public";

interface RecordedStep {
  options: TraceStepOptions;
  /** Step names active when this step started — its ancestry. */
  stack: string[];
  /** options.summarize applied to the step fn's result, as a real client would. */
  summary?: Record<string, unknown> | undefined;
}

const steps: RecordedStep[] = [];
const stepStack: string[] = [];

const traceRun = vi.fn(async (_params: unknown, fn: (trace: object) => Promise<unknown>) =>
  fn({
    runId: "trace-run-checks",
    rootSpanId: "root-span",
    async step(options: TraceStepOptions, stepFn: (spanId: string) => Promise<unknown>) {
      const recorded: RecordedStep = { options, stack: [...stepStack] };
      steps.push(recorded);
      stepStack.push(options.step_name ?? "?");
      try {
        const result = await stepFn(`span-${steps.length}`);
        recorded.summary = options.summarize?.(result);
        return result;
      } finally {
        stepStack.pop();
      }
    },
    recordEvent() {
      return "event-1";
    },
    endRoot() {},
    traceTool<T>(_name: string, _params: Record<string, unknown>, fn: () => Promise<T>) {
      return fn();
    },
  }),
);

beforeEach(() => {
  steps.length = 0;
  stepStack.length = 0;
  traceRun.mockClear();
  if (existsSync(TMP_ROOT)) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
  taskDir = join(TMP_ROOT, `case-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(taskDir, { recursive: true });
  // The judge is a plain OpenAI-shaped POST; stub fetch so the run needs no
  // real provider. The verdict content is what callJudge parses.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: '{"pass":true,"reasoning":"overview is substantive"}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      }),
    ),
  );

  writeFileSync(
    join(taskDir, `${basename(taskDir)}.eval.ts`),
    `
import { defineTask } from "${LOCAL_DEFINE_TASK_IMPORT}";
import { testAdapter } from "./adapter";

export default defineTask(testAdapter, {
  id: "grouped-task",
  description: "Evaluation grouping task",
  deliverables: ["report"],
});
`,
  );
  writeFileSync(
    join(taskDir, "adapter.ts"),
    `
import { z } from "zod";
import { defineAdapter } from "${LOCAL_DEFINE_ADAPTER_IMPORT}";

export const testAdapter = defineAdapter({
  name: "test-adapter",
  deliverables: {
    report: z.object({ title: z.string(), overview: z.string() }),
  },
  turn: async ({ transcript }) => {
    if (transcript.length > 0) return null;
    return "test-prompt";
  },
  async startSession() {
    return {
      async sendUserTurn(turn: unknown) {
        return { response: "ack:" + String(turn) };
      },
    };
  },
  async collectDeliverables() {
    return { report: { title: "Summary", overview: "A thorough overview." } };
  },
});
`,
  );
  writeFileSync(
    join(taskDir, "checks.ts"),
    `
import { equals, test } from "${LOCAL_CHECKS_IMPORT}";

test("overview-quality", async (t, { deliverables }) => {
  await t.judge(deliverables.report.overview, "Is the overview substantive?");
});

test("title-check", (t, { deliverables }) => {
  t.check(deliverables.report.title, equals("Deliberately Wrong"));
});
`,
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (existsSync(TMP_ROOT)) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});

describe("checks.run evaluation-phase span", () => {
  it("wraps the checks execution and nests judge spans under it", async () => {
    const result = await runTask(taskDir, {
      tracing: {
        client: { traceRun },
        project: "sdk-tests",
      },
      judge: { model: "judge-model", baseURL: "https://judge.test/v1", apiKey: "test-key" },
    });

    // One failing expect + one passing judgment — the summary counts must
    // reflect both sides of the evaluation.
    expect(result.result.pass).toBe(false);

    const checksRun = steps.find((s) => s.options.step_name === "checks.run");
    expect(checksRun).toBeDefined();
    expect(checksRun!.options.observation_type).toBe("CHAIN");
    // Direct child of the root — the phase sits at the top level, after the
    // execution phase, not inside any turn.
    expect(checksRun!.stack).toEqual([]);

    const judge = steps.find((s) => s.options.step_name?.startsWith("judge:"));
    expect(judge).toBeDefined();
    // The judge span nests directly under checks.run — the grouping boundary.
    expect(judge!.stack).toEqual(["checks.run"]);

    // Execution-phase work must stay outside the evaluation span.
    const turn = steps.find((s) => s.options.step_name === "task.turn");
    expect(turn).toBeDefined();
    expect(turn!.stack).toEqual([]);

    // The structured summary rides the verdict channel (tool_result), the
    // same channel judge verdicts use — readable text plus machine counts.
    expect(checksRun!.summary?.verdict).toMatchObject({
      total: 2,
      passCount: 1,
      failCount: 1,
    });
    expect(checksRun!.summary?.text).toContain("1/2");
  });

  it("separates no-verdict (judge-error) checks from genuine failures in the summary", async () => {
    // The judge provider 500s on every call: the check records an error
    // outcome — "quality unknown, not failed" (issue #323) — and the phase
    // summary must not lump it into failCount.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    writeFileSync(
      join(taskDir, "checks.ts"),
      `
import { equals, test } from "${LOCAL_CHECKS_IMPORT}";

test("flaky-judge", async (t, { deliverables }) => {
  await t.judge(deliverables.report.overview, "Is the overview substantive?");
});

test("title-check", (t, { deliverables }) => {
  t.check(deliverables.report.title, equals("Deliberately Wrong"));
});
`,
    );

    const result = await runTask(taskDir, {
      tracing: {
        client: { traceRun },
        project: "sdk-tests",
      },
      judge: { model: "judge-model", baseURL: "https://judge.test/v1", apiKey: "test-key" },
    });

    expect(result.result.pass).toBe(false);
    const checksRun = steps.find((s) => s.options.step_name === "checks.run")!;
    expect(checksRun.summary?.verdict).toMatchObject({
      total: 2,
      passCount: 0,
      failCount: 1,
      noVerdictCount: 1,
    });
    const verdict = checksRun.summary?.verdict as
      | { results?: Array<{ id: string; outcome?: string }> }
      | undefined;
    const lines = verdict?.results ?? [];
    expect(lines.find((l) => l.id === "flaky-judge")?.outcome).toBe("error");
    expect(lines.find((l) => l.id === "title-check")?.outcome).toBeUndefined();
    expect(checksRun.summary?.text).toContain("no-verdict");
  });

  it("emits checks.run even when no check uses a judge", async () => {
    writeFileSync(
      join(taskDir, "checks.ts"),
      `
import { equals, test } from "${LOCAL_CHECKS_IMPORT}";

test("sync-only", (t, { deliverables }) => {
  t.check(deliverables.report.title, equals("Summary"));
});
`,
    );

    const result = await runTask(taskDir, {
      tracing: {
        client: { traceRun },
        project: "sdk-tests",
      },
    });

    expect(result.result.pass).toBe(true);
    const checksRun = steps.find((s) => s.options.step_name === "checks.run");
    expect(checksRun).toBeDefined();
    expect(checksRun!.options.observation_type).toBe("CHAIN");
    expect(steps.filter((s) => s.options.step_name?.startsWith("judge:"))).toHaveLength(0);
    expect(checksRun!.summary?.verdict).toMatchObject({
      total: 1,
      passCount: 1,
      failCount: 0,
    });
  });
});
