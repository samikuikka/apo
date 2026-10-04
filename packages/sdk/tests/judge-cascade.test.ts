/**
 * Cascade judge mode (`judge.mode: "cascade"`): the second judge
 * answers first; a confident verdict (native confidence >= 0.95) stands
 * without calling the primary LLM judge.
 *
 * Invariants under test:
 * - confident verdict decides: zero chat/completions requests, provenance
 *   recorded (`verdict_by: "second-judge"`, decision model in metadata);
 * - everything else fails open to the primary judge: low confidence,
 *   transport error, oversize-skip, projected secondJudgeValue view;
 * - cascade issues exactly ONE decisions call per check (the prefetched
 *   evidence is reused, never re-requested);
 * - mode off (with a second judge configured) is today's dual behavior:
 *   evidence-only, no verdict_by, one decisions + one chat call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineCheck,
  resetFlowChecks,
  runTraceChecks,
} from "../src/agent-task/checks/flow-runner.ts";
import { resolveJudgeConfig } from "../src/agent-task/checks/t.ts";
import type { TraceProjectionSnapshot } from "../src/agent-task/trace-projection/types.ts";

// Judge checks read no trace evidence — an observations-less snapshot is
// the honest minimal fixture (pattern from judge-check.test.ts).
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

const cascadeConfig = {
  model: "test/judge",
  baseURL: "https://judge.test/v1",
  apiKey: "secret",
  mode: "cascade" as const,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetFlowChecks();
});

/**
 * Route fetch by URL: chat gets a primary verdict, decisions gets a
 * Jev-shaped answer. Returns the call log so tests can assert on who was
 * actually paid.
 */
function stubBoth(decisions: () => Promise<Response>): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/chat/completions")) {
        return Response.json({
          choices: [{ message: { content: '{"reasoning":"primary says ok","pass":true}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.002 },
        });
      }
      return decisions();
    }) as unknown as typeof fetch,
  );
  return { calls };
}

function jevResponse(choice = "pass", passProb = 0.99, confidence = 0.98) {
  return Response.json({
    answers: {
      verdict: {
        type: "choice",
        choice,
        probabilities: { pass: passProb, fail: 1 - passProb },
        confidence,
      },
    },
    usage: { input_tokens: 421, cost: 0.0000177 },
  });
}

/**
 * Run one t.judge check against the stubbed endpoints and return the
 * recorded check plus the fetch call log.
 */
async function runOne(config: typeof cascadeConfig, jev: () => Promise<Response>, judgeOpts?: { secondJudgeValue?: unknown }) {
  const { calls } = stubBoth(jev);
  defineCheck("criterion", async (t) => {
    await t.judge("the deliverable", "Is it good?", judgeOpts);
  });
  const [result] = await runTraceChecks({
    snapshot: emptySnapshot,
    deliverables: {},
    judgeConfig: config,
  });
  return { result, calls };
}

const chatCalls = (calls: string[]) => calls.filter((u) => u.endsWith("/chat/completions"));
const decisionsCalls = (calls: string[]) => calls.filter((u) => u.includes("alpha/decisions"));

describe("cascade mode", () => {
  it("confident pass decides: no primary call, provenance recorded", async () => {
    vi.stubEnv("APO_SECOND_JUDGE_MODEL", "typesafe/jev-1.13");
    const { result, calls } = await runOne(cascadeConfig, () => jevResponse("pass", 0.99, 0.98));

    expect(result).toMatchObject({
      id: "criterion",
      pass: true,
      evaluator_type: "llm",
      judge: {
        model: "typesafe/jev-1.13",
        verdict_by: "second-judge",
        secondJudge: { choice: "pass", confidence: 0.98 },
      },
    });
    expect(result.reasoning).toContain("Verdict by second judge (cascade)");
    expect(result.reasoning).toContain("Primary judge not called");
    expect(chatCalls(calls)).toHaveLength(0);
    expect(decisionsCalls(calls)).toHaveLength(1);
  });

  it("confident fail decides the same way", async () => {
    vi.stubEnv("APO_SECOND_JUDGE_MODEL", "typesafe/jev-1.13");
    const { result, calls } = await runOne(cascadeConfig, () => jevResponse("fail", 0.02, 0.97));

    expect(result).toMatchObject({ pass: false, judge: { verdict_by: "second-judge" } });
    expect(chatCalls(calls)).toHaveLength(0);
  });

  it("confidence exactly 0.95 decides (boundary)", async () => {
    vi.stubEnv("APO_SECOND_JUDGE_MODEL", "typesafe/jev-1.13");
    const { result, calls } = await runOne(cascadeConfig, () => jevResponse("pass", 0.99, 0.95));
    expect(result.judge?.verdict_by).toBe("second-judge");
    expect(chatCalls(calls)).toHaveLength(0);
  });

  it("low confidence defers to the primary judge, evidence attached, one decisions call", async () => {
    vi.stubEnv("APO_SECOND_JUDGE_MODEL", "typesafe/jev-1.13");
    const { result, calls } = await runOne(cascadeConfig, () => jevResponse("fail", 0.4, 0.72));

    // The primary's verdict stands; the unsure second judge is evidence only.
    expect(result).toMatchObject({
      pass: true,
      reasoning: "primary says ok",
      judge: { model: "test/judge" },
    });
    expect(result.judge?.verdict_by).toBeUndefined();
    expect(result.judge?.secondJudge).toMatchObject({ choice: "fail", confidence: 0.72 });
    expect(chatCalls(calls)).toHaveLength(1);
    expect(decisionsCalls(calls)).toHaveLength(1);
  });

  it("second-judge transport error fails open to the primary", async () => {
    vi.stubEnv("APO_SECOND_JUDGE_MODEL", "typesafe/jev-1.13");
    const { result, calls } = await runOne(cascadeConfig, () =>
      Promise.resolve(Response.json({ error: "boom" }, { status: 500 })),
    );

    expect(result).toMatchObject({ pass: true, reasoning: "primary says ok" });
    expect(result.judge?.secondJudge?.error).toContain("500");
    expect(chatCalls(calls)).toHaveLength(1);
  });

  it("oversize-skip fails open to the primary", async () => {
    vi.stubEnv("APO_SECOND_JUDGE_MODEL", "typesafe/jev-1.13");
    const { result, calls } = await runOne(cascadeConfig, () =>
      Promise.resolve(
        Response.json({ error: { type: "max_tokens_exceeded" } }, { status: 400 }),
      ),
    );

    expect(result).toMatchObject({ pass: true });
    expect(result.judge?.secondJudge?.skipped).toContain("exceeds");
    expect(chatCalls(calls)).toHaveLength(1);
  });

  it("a projected secondJudgeValue never decides, however confident", async () => {
    vi.stubEnv("APO_SECOND_JUDGE_MODEL", "typesafe/jev-1.13");
    const { result, calls } = await runOne(
      cascadeConfig,
      () => jevResponse("fail", 0.01, 0.99),
      { secondJudgeValue: "small view" },
    );

    expect(result).toMatchObject({ pass: true, reasoning: "primary says ok" });
    expect(result.judge?.verdict_by).toBeUndefined();
    expect(result.judge?.secondJudge?.projected).toBe(true);
    expect(chatCalls(calls)).toHaveLength(1);
    expect(decisionsCalls(calls)).toHaveLength(1);
  });

  it("cascade without a configured second judge behaves as mode-off", async () => {
    // APO_SECOND_JUDGE_MODEL deliberately unset.
    const { result, calls } = await runOne(cascadeConfig, () => jevResponse());

    expect(result).toMatchObject({ pass: true, reasoning: "primary says ok" });
    expect(result.judge?.secondJudge).toBeUndefined();
    expect(chatCalls(calls)).toHaveLength(1);
    expect(decisionsCalls(calls)).toHaveLength(0);
  });

  it("mode off with a second judge = today's dual behavior (evidence-only)", async () => {
    vi.stubEnv("APO_SECOND_JUDGE_MODEL", "typesafe/jev-1.13");
    const dual = { model: "test/judge", baseURL: "https://judge.test/v1", apiKey: "secret" };
    const { result, calls } = await runOne(dual, () => jevResponse("fail", 0.02, 0.99));

    // A fully confident disagreeing second judge still does not decide.
    expect(result).toMatchObject({ pass: true, reasoning: "primary says ok" });
    expect(result.judge?.verdict_by).toBeUndefined();
    expect(result.judge?.secondJudge).toMatchObject({ choice: "fail" });
    expect(chatCalls(calls)).toHaveLength(1);
    expect(decisionsCalls(calls)).toHaveLength(1);
  });
});

describe("resolveJudgeConfig mode precedence", () => {
  it("per-call wins over base, and absent means unset", () => {
    const base = { model: "a", mode: "cascade" as const };
    expect(resolveJudgeConfig(base, undefined)?.mode).toBe("cascade");
    expect(resolveJudgeConfig(base, { model: "b" })?.mode).toBe("cascade");
    expect(resolveJudgeConfig({ model: "a" }, { model: "b", mode: "cascade" })?.mode).toBe("cascade");
    expect(resolveJudgeConfig({ model: "a" }, { model: "b" })?.mode).toBeUndefined();
  });
});
