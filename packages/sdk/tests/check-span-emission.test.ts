/**
 * Issue #344: every check gets a span under checks.run — deterministic
 * `t.check` assertions included — with judge spans nested under the check
 * that issued them, and the check-level evaluator_type derived from the
 * recorded assertions instead of hard-coded "code".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  defineCheck,
  resetFlowChecks,
  runTraceChecks,
} from "../src/agent-task/checks/flow-runner.ts";
import { equals } from "../src/agent-task/checks/matchers.ts";
import type { JudgeTracer } from "../src/agent-task/tracing.ts";
import type { TraceStepOptions } from "../src/types.ts";
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

const judgeConfig = {
  model: "test/judge",
  baseURL: "https://judge.test/v1",
  apiKey: "secret",
};

interface RecordedStep {
  name: string;
  /** How many steps were already open when this one started. 0 = top level. */
  depthAtOpen: number;
  /** The summarize() output captured when the step's fn resolved. */
  output: unknown;
}

/**
 * A JudgeTracer that records every step span: its name, the nesting depth
 * at open time, and the summarized output. Nesting depth is what proves a
 * `judge:*` span landed under its `check:*` span and not beside it.
 *
 * Depth is tracked through AsyncLocalStorage — the same propagation
 * mechanism the real OTel client uses — so concurrently running checks
 * (Promise.all) each keep their own depth instead of sharing a stack.
 */
function trackingTracer(): { tracer: JudgeTracer; steps: RecordedStep[] } {
  const steps: RecordedStep[] = [];
  const storage = new AsyncLocalStorage<{ depth: number }>();
  const tracer: JudgeTracer = {
    async step<T>(
      options: TraceStepOptions,
      fn: (spanId: string) => Promise<T>,
    ): Promise<T> {
      const depth = storage.getStore()?.depth ?? 0;
      const step: RecordedStep = {
        name: options.step_name ?? "",
        depthAtOpen: depth,
        output: undefined,
      };
      steps.push(step);
      const result = await storage.run({ depth: depth + 1 }, () => fn(`span-${steps.length}`));
      step.output = options.summarize?.(result) ?? null;
      return result;
    },
    traceTool<T>(_name: string, _params: Record<string, unknown>, fn: () => Promise<T>) {
      return fn();
    },
  };
  return { tracer, steps };
}

function stubJudgeResponse(args: { pass: boolean; reasoning: string }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: JSON.stringify(args) } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetFlowChecks();
});

describe("per-check spans (issue #344)", () => {
  it("emits one check:<id> span per check, deterministic checks included", async () => {
    defineCheck("a-deterministic", (t) => {
      t.check(1, equals(1));
    });
    defineCheck("b-deterministic", (t) => {
      t.check("x", equals("x"));
    });

    const { tracer, steps } = trackingTracer();
    const results = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeTracer: tracer,
    });

    expect(results).toHaveLength(2);
    expect(steps.map((s) => s.name).toSorted()).toEqual([
      "check:a-deterministic",
      "check:b-deterministic",
    ]);
    // Both spans sat directly under the evaluation phase — no stray nesting.
    expect(steps.every((s) => s.depthAtOpen === 0)).toBe(true);
  });

  it("summarizes verdict and assertion expected/received on the span", async () => {
    defineCheck("structural", (t) => {
      t.check(2, equals(3));
    });

    const { tracer, steps } = trackingTracer();
    await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeTracer: tracer,
    });

    const output = steps[0]!.output as {
      pass: boolean;
      reasoning: string;
      evaluator_type: string;
      assertions: Array<{ id: string; pass: boolean; expected?: string; received?: unknown }>;
    };
    expect(output.pass).toBe(false);
    expect(output.evaluator_type).toBe("code");
    expect(output.assertions).toHaveLength(1);
    // t.check records expected = the matcher's description, received = the
    // actual value the run produced.
    expect(output.assertions[0]).toMatchObject({ pass: false, received: "2" });
  });

  it("nests the judge span under the check that issued it", async () => {
    stubJudgeResponse({ pass: true, reasoning: "meets the rubric" });
    defineCheck("quality", async (t) => {
      await t.judge("complete answer", "PASS when complete");
    });

    const { tracer, steps } = trackingTracer();
    await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
      judgeTracer: tracer,
    });

    expect(steps.map((s) => s.name)).toEqual(["check:quality", "judge:quality"]);
    expect(steps[0]!.depthAtOpen).toBe(0);
    expect(steps[1]!.depthAtOpen).toBe(1);
  });

  it("runs without a tracer and still returns results", async () => {
    defineCheck("untraced", (t) => {
      t.check(1, equals(1));
    });

    const results = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.pass).toBe(true);
  });
});

describe("check-level evaluator_type derivation (issue #344)", () => {
  it("stays \"code\" for purely deterministic checks", async () => {
    defineCheck("structural", (t) => {
      t.check(1, equals(1));
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
    });

    expect(result?.evaluator_type).toBe("code");
  });

  it("reports \"llm\" when every assertion judged", async () => {
    stubJudgeResponse({ pass: true, reasoning: "meets the rubric" });
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(result?.evaluator_type).toBe("llm");
  });

  it("reports \"mixed\" when a check combines t.check and t.judge", async () => {
    stubJudgeResponse({ pass: true, reasoning: "meets the rubric" });
    defineCheck("both", async (t) => {
      t.check(1, equals(1));
      await t.judge("answer", "PASS when correct");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(result?.evaluator_type).toBe("mixed");
  });
});

describe("judge reasoning on a passing check (issue #344)", () => {
  it("carries the judge's explanation instead of \"passed\"", async () => {
    stubJudgeResponse({ pass: true, reasoning: "the memo covers the requirement" });
    defineCheck("quality", async (t) => {
      await t.judge("the memo", "PASS when the requirement is covered");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(result?.pass).toBe(true);
    expect(result?.reasoning).toBe("the memo covers the requirement");
  });

  it("keeps \"passed\" for deterministic checks", async () => {
    defineCheck("structural", (t) => {
      t.check(1, equals(1));
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
    });

    expect(result?.reasoning).toBe("passed");
  });
});

describe("span output size discipline", () => {
  it("truncates an oversized received value to the compaction marker", async () => {
    const bigValue = "x".repeat(5 * 1024);
    stubJudgeResponse({ pass: true, reasoning: "ok" });
    defineCheck("big", async (t) => {
      await t.judge(bigValue, "PASS when correct");
    });

    const { tracer, steps } = trackingTracer();
    await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
      judgeTracer: tracer,
    });

    const output = steps[0]!.output as {
      assertions: Array<{ received: unknown }>;
    };
    expect(output.assertions[0]!.received).toMatchObject({
      kind: "truncated",
      size_bytes: 5 * 1024 + 2,
    });
    // The check result itself keeps the full value — truncation is
    // span-presentation only.
  });
});
