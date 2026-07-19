import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineCheck,
  resetFlowChecks,
  runTraceChecks,
} from "../src/agent-task/checks/flow-runner.ts";
import type { TraceProjectionSnapshot } from "../src/agent-task/trace-projection/types.ts";

// An empty TraceProjectionSnapshot — judge checks don't read any trace
// evidence, so an observations-less snapshot is the honest minimal fixture.
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

afterEach(() => {
  vi.unstubAllGlobals();
  resetFlowChecks();
});

describe("t.judge", () => {
  it("records a passing LLM check with judge metadata", async () => {
    stubJudgeResponse({
      content: JSON.stringify({ pass: true, reasoning: "meets the rubric" }),
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    });
    defineCheck("quality", async (t) => {
      await t.judge("complete answer", "PASS when complete");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(result).toMatchObject({
      id: "quality",
      pass: true,
      evaluator_type: "code",
      judge: {
        model: "test/judge",
        tokens: { input: 12, output: 4 },
      },
    });
    expect(result?.assertions?.[0]).toMatchObject({
      pass: true,
      evaluator_type: "llm",
      expected: "PASS when complete",
    });
  });

  it("records the judge's failed verdict", async () => {
    stubJudgeResponse({
      content: JSON.stringify({ pass: false, reasoning: "missing evidence" }),
    });
    defineCheck("quality", async (t) => {
      await t.judge("guess", "PASS when grounded");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(result).toMatchObject({
      pass: false,
      reasoning: "missing evidence",
      evaluator_type: "code",
    });
  });

  it("fails as an LLM check when no judge is configured", async () => {
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
    });

    expect(result).toMatchObject({
      pass: false,
      evaluator_type: "code",
    });
    // The message lists environmental setup options — match the prefix to
    // stay resilient to wording tweaks in the SDK's judge config resolver.
    expect(result.reasoning).toMatch(/^No judge model configured\./);
    expect(result.reasoning).toContain("OPENROUTER_MODEL");
    expect(result.reasoning).toContain("OPENAI_MODEL");
  });

  it("records malformed provider output as a failed judge verdict", async () => {
    stubJudgeResponse({ content: "not-json" });
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(result).toMatchObject({
      pass: false,
      evaluator_type: "code",
      judge: { response: "not-json" },
    });
    // Malformed output is a failure with a plain-language explanation (not a
    // raw dump of the response). The raw response stays on judge metadata.
    expect(result?.reasoning).toContain("could not be parsed");
    expect(result?.reasoning).not.toContain("not-json");
  });

  it("treats a zero-output-token response as a transient failure", async () => {
    // OpenRouter occasionally cuts a stream mid-generation and returns a
    // stub like "[" with completion_tokens: 0. That's a provider failure,
    // not a verdict — guard it before parsing.
    stubJudgeResponse({ content: "[", usage: { completion_tokens: 0 } });
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(result).toMatchObject({
      pass: false,
      evaluator_type: "code",
      judge: { response: "[" },
    });
    expect(result?.reasoning).toContain("empty or truncated");
    expect(result?.reasoning).not.toEqual("[");
  });

  it("turns provider errors into an LLM check failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(result).toMatchObject({
      pass: false,
      evaluator_type: "code",
    });
    expect(result?.reasoning).toContain("Judge API 503");
  });
});

function stubJudgeResponse(args: {
  content: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: args.content } }],
        usage: args.usage,
      }),
    ),
  );
}
