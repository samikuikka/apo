/**
 * Second grader: an opt-in typed-decision model that grades alongside the
 * primary LLM judge. Measured motivation (prod shadow re-judge of 2,094
 * checks via typesafe/jev-1.13): 96.2% agreement with the primary judge,
 * confidence calibrated (99.5% agreement at conf >= 0.95, 71% below 0.6),
 * ~$0.0001 and ~0.34s per check.
 *
 * Invariants under test:
 * - off by default: no decisions call, no `secondJudge` field;
 * - on: evidence attached, primary verdict + reasoning byte-identical;
 * - a failing decisions endpoint records `error` and never fails the check;
 * - "none"/"off"/empty disable the feature like unset.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { callJudge } from "../src/agent-task/checks/judge.ts";
import { decisionsEndpoint } from "../src/agent-task/checks/second-judge.ts";

const judgeArgs = {
  values: ["the deliverable"],
  instruction: "Is it good?",
  model: "test/judge",
  baseURL: "https://judge.test/v1",
  apiKey: "secret",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/**
 * Route fetch by URL: the chat endpoint gets a normal judge verdict, the
 * decisions endpoint gets a Jev-shaped answer.
 */
function stubBoth(decisions: () => Promise<Response>): { calls: vi.Mock } {
  const fetchMock = vi.fn(async (url: string | URL) => {
    if (String(url).endsWith("/chat/completions")) {
      return Response.json({ choices: [{ message: { content: '{"reasoning":"ok","pass":true}' } }] });
    }
    return decisions();
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return { calls: fetchMock as unknown as vi.Mock };
}

function jevResponse(choice = "fail", passProb = 0.03, confidence = 0.95) {
  return Response.json({
    answers: {
      verdict: { type: "choice", choice, probabilities: { pass: passProb, fail: 1 - passProb }, confidence },
    },
    usage: { input_tokens: 421, cost: 0.0000177 },
  });
}

describe("second judge wiring", () => {
  it("off by default: no decisions call, no secondJudge evidence", async () => {
    const { calls } = stubBoth(async () => jevResponse());
    const result = await callJudge(judgeArgs);
    expect(result.judge.secondJudge).toBeUndefined();
    const urls = calls.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("alpha/decisions"))).toBe(false);
  });

  it('"none" and empty behave like unset', async () => {
    for (const value of ["none", "off", "", "   "]) {
      vi.stubEnv("APO_SECOND_JUDGE_MODEL", value);
      const { calls } = stubBoth(async () => jevResponse());
      const result = await callJudge(judgeArgs);
      expect(result.judge.secondJudge).toBeUndefined();
      expect(calls.mock.calls.filter((c) => String(c[0]).includes("alpha/decisions"))).toHaveLength(0);
    }
  });

  it("on: posts the same state to the decisions endpoint and attaches evidence", async () => {
    vi.stubEnv("APO_SECOND_JUDGE_MODEL", "typesafe/jev-1.13");
    const { calls } = stubBoth(async () => jevResponse("fail", 0.03, 0.95));
    const result = await callJudge(judgeArgs);

    // Primary verdict untouched — the second grader never votes.
    expect(result.pass).toBe(true);
    expect(result.reasoning).toBe("ok");

    const evidence = result.judge.secondJudge;
    expect(evidence?.model).toBe("typesafe/jev-1.13");
    expect(evidence?.choice).toBe("fail");
    expect(evidence?.passProbability).toBeCloseTo(0.03);
    expect(evidence?.confidence).toBeCloseTo(0.95);
    expect(evidence?.inputTokens).toBe(421);
    expect(evidence?.error).toBeUndefined();

    const decCall = calls.mock.calls.find((c) => String(c[0]).includes("alpha/decisions"));
    expect(decCall).toBeDefined();
    const body = JSON.parse(decCall![1].body as string) as {
      model: string;
      state: string;
      questions: Record<string, { type: string }>;
    };
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.questions.verdict?.type).toBe("choice");
    // The state carries the deliverable the primary judge graded.
    expect(body.state).toContain("the deliverable");
    expect(body.state).toContain("Is it good?");
  });

  it("decisions endpoint failure: error recorded, check still passes", async () => {
    vi.stubEnv("APO_SECOND_JUDGE_MODEL", "typesafe/jev-1.13");
    stubBoth(async () => new Response("boom", { status: 500 }));
    const result = await callJudge(judgeArgs);
    expect(result.pass).toBe(true);
    expect(result.judge.secondJudge?.error).toContain("500");
    expect(result.judge.secondJudge?.choice).toBeUndefined();
  });

  it("malformed decisions answer: error recorded, verdict untouched", async () => {
    vi.stubEnv("APO_SECOND_JUDGE_MODEL", "typesafe/jev-1.13");
    stubBoth(async () => Response.json({ answers: {} }));
    const result = await callJudge(judgeArgs);
    expect(result.pass).toBe(true);
    expect(result.judge.secondJudge?.error).toContain("no verdict choice");
  });
  it("HTML answer (site root instead of API root) names the misconfiguration", async () => {
    vi.stubEnv("APO_SECOND_JUDGE_MODEL", "typesafe/jev-1.13");
    stubBoth(async () =>
      new Response("<!DOCTYPE html><html></html>", {
        headers: { "content-type": "text/html" },
      }),
    );
    const result = await callJudge(judgeArgs);
    expect(result.pass).toBe(true); // the check itself is unaffected
    expect(result.judge.secondJudge?.error).toContain("returned HTML");
    expect(result.judge.secondJudge?.error).toContain("APO_SECOND_JUDGE_BASE_URL");
    expect(result.judge.secondJudge?.error).toContain("https://openrouter.ai/api/v1");
  });

  it("non-JSON body without content-type also gets the guidance", async () => {
    vi.stubEnv("APO_SECOND_JUDGE_MODEL", "typesafe/jev-1.13");
    stubBoth(async () => new Response("<html>proxy error page</html>"));
    const result = await callJudge(judgeArgs);
    expect(result.judge.secondJudge?.error).toContain("non-JSON body");
    expect(result.judge.secondJudge?.error).toContain("APO_SECOND_JUDGE_BASE_URL");
  });
});

describe("second judge connection overrides (proxied primary)", () => {
  it("base URL override: decisions call goes to the override, not the primary's host", async () => {
    vi.stubEnv("APO_SECOND_JUDGE_MODEL", "typesafe/jev-1.13");
    vi.stubEnv("APO_SECOND_JUDGE_BASE_URL", "https://openrouter.ai/api/v1");
    const { calls } = stubBoth(async () => jevResponse());
    await callJudge(judgeArgs); // primary base is https://judge.test/v1
    const decCall = calls.mock.calls.find((c) => String(c[0]).includes("alpha/decisions"));
    expect(String(decCall?.[0])).toBe("https://openrouter.ai/api/alpha/decisions");
    // the primary judge still uses its own base
    expect(calls.mock.calls.some((c) => String(c[0]) === "https://judge.test/v1/chat/completions")).toBe(true);
  });

  it("API key override: the decisions call bears it, the primary keeps its own", async () => {
    vi.stubEnv("APO_SECOND_JUDGE_MODEL", "typesafe/jev-1.13");
    vi.stubEnv("APO_SECOND_JUDGE_API_KEY", "sk-or-second");
    const { calls } = stubBoth(async () => jevResponse());
    await callJudge(judgeArgs); // primary key is "secret"
    const decCall = calls.mock.calls.find((c) => String(c[0]).includes("alpha/decisions"));
    const decHeaders = (decCall?.[1]?.headers ?? {}) as Record<string, string>;
    expect(decHeaders.Authorization).toBe("Bearer sk-or-second");
    const primaryCall = calls.mock.calls.find(
      (c) => String(c[0]).endsWith("/chat/completions"),
    );
    const primaryHeaders = (primaryCall?.[1]?.headers ?? {}) as Record<string, string>;
    expect(primaryHeaders.Authorization).toBe("Bearer secret");
  });

  it("overrides unset: falls back to the primary judge's base and key", async () => {
    vi.stubEnv("APO_SECOND_JUDGE_MODEL", "typesafe/jev-1.13");
    const { calls } = stubBoth(async () => jevResponse());
    await callJudge(judgeArgs);
    const decCall = calls.mock.calls.find((c) => String(c[0]).includes("alpha/decisions"));
    expect(String(decCall?.[0])).toBe("https://judge.test/alpha/decisions");
    const decHeaders = (decCall?.[1]?.headers ?? {}) as Record<string, string>;
    expect(decHeaders.Authorization).toBe("Bearer secret");
  });
});

describe("decisionsEndpoint URL derivation", () => {
  it.each([
    ["https://openrouter.ai/api/v1", "https://openrouter.ai/api/alpha/decisions"],
    ["https://openrouter.ai/api/v1/", "https://openrouter.ai/api/alpha/decisions"],
    ["https://proxy.example/v1", "https://proxy.example/alpha/decisions"],
    ["https://proxy.example", "https://proxy.example/alpha/decisions"],
  ])("%s -> %s", (base, expected) => {
    expect(decisionsEndpoint(base)).toBe(expected);
  });
});
