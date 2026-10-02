import { describe, it, expect, vi, afterEach } from "vitest";
import {
  defineCheck,
  resetFlowChecks,
  runTraceChecks,
} from "../src/agent-task/checks/flow-runner.ts";
import type { TraceProjectionSnapshot } from "../src/agent-task/trace-projection/types.ts";

/**
 * Judge-span spend attribution (issue #288): the step span a judge opens
 * carries its model and token counts — extracted post-hoc from the judged
 * result, the same contract as `summarize` — so the backend prices judge
 * calls and trace rollups count their spend. These tests drive the public
 * check surface with a recording tracer (t.judge) and a scripted endpoint
 * (t.agent), the way an eval file reaches it.
 */

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

type StepRecord = {
  name: string | undefined;
  model: string | undefined;
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  spanId: string;
};

/** Records every step span a judge opened, mirroring the real client's
 *  contract: `usage` runs when the span ends, against the step's result. */
function recordingTracer() {
  const steps: StepRecord[] = [];
  const tools: { name: string; parentStep: string | null }[] = [];
  let currentStep: string | null = null;
  let next = 0;
  const tracer = {
    async step<T>(
      options: {
        step_name?: string;
        model?: string;
        usage?: (
          result: unknown,
        ) => { prompt_tokens?: number; completion_tokens?: number } | undefined;
      },
      fn: (spanId: string) => Promise<T>,
    ): Promise<T> {
      const spanId = `span-${++next}`;
      const record: StepRecord = {
        name: options.step_name,
        model: options.model,
        usage: undefined,
        spanId,
      };
      steps.push(record);
      currentStep = spanId;
      try {
        const result = await fn(spanId);
        record.usage = options.usage?.(result);
        return result;
      } finally {
        currentStep = null;
      }
    },
    async traceTool<TN>(
      name: string,
      _params: Record<string, unknown>,
      fn: () => Promise<TN>,
    ): Promise<TN> {
      tools.push({ name, parentStep: currentStep });
      return fn();
    },
  };
  return { tracer, steps, tools };
}

function stubJudgeResponse(content: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      }),
    ),
  );
}

function toolCallTurn(id: string, name: string, args: unknown) {
  return {
    id: `chatcmpl-${id}`,
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call-${id}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 8 },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetFlowChecks();
});

describe("judge-span spend attribution (issue #288)", () => {
  it("t.judge: the span carries the judge's model and the call's tokens", async () => {
    stubJudgeResponse(JSON.stringify({ pass: true, reasoning: "fine" }));
    const { tracer, steps } = recordingTracer();
    defineCheck("quality", async (t) => {
      await t.judge("complete answer", "PASS when complete");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
      judgeTracer: tracer,
    });

    // One span for the check, one for the judge call it issued (issue #344).
    expect(steps.map((s) => s.name)).toEqual(["check:quality", "judge:quality"]);
    const judgeStep = steps.find((s) => s.name === "judge:quality");
    // The model lets the backend price the span; the tokens are the ones the
    // judge provider reported (stubbed usage above).
    expect(judgeStep?.model).toBe("test/judge");
    expect(judgeStep?.usage).toEqual({ prompt_tokens: 12, completion_tokens: 4 });
    expect(result?.judge?.model).toBe("test/judge");
  });

  it("t.agent: the span carries the session's tokens; its tool calls nest under it", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = [
          toolCallTurn("1", "read_deliverable", { name: "answer", offset: 0, limit: 6000 }),
          toolCallTurn("2", "finish_verdict", { reasoning: "grounded", pass: true }),
        ][Math.min(call, 1)];
        call += 1;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const { tracer, steps, tools } = recordingTracer();
    defineCheck("agent-under-test", async (t) => {
      await t.agent("PASS if the answer matches the log.");
    });

    await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: { answer: "42", log: "step1\nstep2" },
      judgeConfig: { model: "test-model", apiKey: "test-key" },
      judgeTracer: tracer,
    });

    // The check span wraps the session span (issue #344); tools nest under
    // the session, their spend owner.
    expect(steps.map((s) => s.name)).toEqual([
      "check:agent-under-test",
      "t.agent:agent-under-test",
    ]);
    const agentStep = steps.find((s) => s.name === "t.agent:agent-under-test");
    expect(agentStep?.model).toBe("test-model");
    // Two scripted turns × the stubbed 120+8 usage.
    expect(agentStep?.usage).toEqual({ prompt_tokens: 240, completion_tokens: 16 });
    // Every evidence read the judge made is a tool span under its step.
    expect(tools.map((t) => t.name)).toContain("read_deliverable");
    expect(tools.every((t) => t.parentStep === agentStep?.spanId)).toBe(true);
  });

  it("t.judge: a failed call records no judge metadata — nothing to link or bill", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream exploded", { status: 500 })),
    );
    const { tracer, steps } = recordingTracer();
    defineCheck("quality", async (t) => {
      await t.judge("complete answer", "PASS when complete");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
      judgeTracer: tracer,
    });

    // The span exists (it ends in error), but the failure record must not
    // carry judge metadata — there is no verdict or usage to find there.
    expect(steps.map((s) => s.name)).toEqual(["check:quality", "judge:quality"]);
    expect(result?.assertions?.[0]?.pass).toBe(false);
    expect(result?.assertions?.[0]?.judge).toBeUndefined();
  });
});
