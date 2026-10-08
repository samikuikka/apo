import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineCheck,
  resetFlowChecks,
  runTraceChecks,
} from "../src/agent-task/checks/flow-runner.ts";
import { callJudge } from "../src/agent-task/checks/judge.ts";
import type { JudgeConfig } from "../src/agent-task/checks/t.ts";
import { equals } from "../src/agent-task/checks/matchers.ts";
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
      evaluator_type: "llm",
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
      evaluator_type: "llm",
    });
  });

  it("expect:'fail' inverts polarity — the check passes when the judge fails a known-bad value", async () => {
    stubJudgeResponse({
      content: JSON.stringify({ pass: false, reasoning: "the figure is fabricated" }),
    });
    defineCheck("quality", async (t) => {
      await t.judge("fabricated report", "PASS when every figure is supported", { expect: "fail" });
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(result).toMatchObject({ pass: true });
    expect(result?.assertions?.[0]).toMatchObject({
      pass: true,
      reasoning: "the figure is fabricated",
    });
  });

  it("expect:'fail' records a disagreement when the judge passes a known-bad value", async () => {
    stubJudgeResponse({
      content: JSON.stringify({ pass: true, reasoning: "reads coherently" }),
    });
    defineCheck("quality", async (t) => {
      await t.judge("fabricated report", "PASS when every figure is supported", { expect: "fail" });
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(result?.pass).toBe(false);
    expect(result?.reasoning).toContain("ground truth is FAIL");
    expect(result?.reasoning).toContain("reads coherently");
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
      evaluator_type: "llm",
      // No judge, no verdict: the same bucket as an unreachable judge (#323).
      outcome: "error",
    });
    expect(result.assertions?.[0]?.outcome).toBe("error");
    // The message lists environmental setup options — match the prefix to
    // stay resilient to wording tweaks in the SDK's judge config resolver.
    expect(result.reasoning).toMatch(/^No judge model configured\./);
    expect(result.reasoning).toContain("OPENROUTER_MODEL");
    expect(result.reasoning).toContain("OPENAI_MODEL");
  });

  it("records malformed provider output as a judge error, not a verdict", async () => {
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
      evaluator_type: "llm",
      judge: { response: "not-json" },
    });
    // No verdict is unknown, not FAIL. The raw response stays on judge metadata.
    expect(result?.reasoning).toContain("no verdict");
    expect(result?.reasoning).not.toContain("not-json");
    expect(result?.assertions?.[0]).toMatchObject({ pass: false, outcome: "error" });
  });

  it("treats a zero-output-token response as a judge error", async () => {
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
      evaluator_type: "llm",
      judge: { response: "[" },
    });
    expect(result?.reasoning).toContain("empty or truncated");
    expect(result?.reasoning).not.toEqual("[");
    expect(result?.assertions?.[0]).toMatchObject({ pass: false, outcome: "error" });
  });

  it("records a provider error as a judge error after one retry, not a verdict", async () => {
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      pass: false,
      evaluator_type: "llm",
    });
    expect(result?.reasoning).toContain("Judge API 503");
    expect(result?.assertions?.[0]).toMatchObject({ pass: false, outcome: "error" });
  });

  it("rolls a judge-only error up to the check-level outcome (issue #323)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    defineCheck("quality", async (t) => {
      t.check(1, equals(1));
      await t.judge("answer", "PASS when correct");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    // The check failed only because the judge never answered — the check
    // carries outcome "error" so scoring can tell it apart from a FAIL.
    expect(result).toMatchObject({ pass: false, outcome: "error" });
  });

  it("keeps a genuine FAIL outcome when a real failure sits beside a judge error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    defineCheck("quality", async (t) => {
      t.check(1, equals(2));
      await t.judge("answer", "PASS when correct");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    // A genuine failure must never be masked by an incidental judge error.
    expect(result).toMatchObject({ pass: false });
    expect(result?.outcome).toBeUndefined();
  });

  it("retries a gateway timeout once and keeps the second attempt's verdict", async () => {
    // A 504 is an idle proxy cutting the connection, not the judge's answer.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>504 Gateway Time-out</html>", { status: 504 }))
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: JSON.stringify({ pass: true, reasoning: "ok" }) } }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result?.pass).toBe(true);
    expect(result?.assertions?.[0]).toMatchObject({ pass: true, reasoning: "ok" });
    expect(result?.assertions?.[0]?.outcome).toBeUndefined();
  });

  it("does not retry a client error", async () => {
    const fetchMock = vi.fn(async () => new Response("bad model", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result?.reasoning).toContain("Judge API 400");
    expect(result?.assertions?.[0]).toMatchObject({ pass: false, outcome: "error" });
  });

  it("retries a network failure once", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: JSON.stringify({ pass: false, reasoning: "no" }) } }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A real FAIL verdict from the judge carries no error outcome.
    expect(result).toMatchObject({ pass: false, reasoning: "no" });
    expect(result?.assertions?.[0]?.outcome).toBeUndefined();
  });

  it("overrides the judge model for a single call", async () => {
    const fetchMock = stubCapturingJudgeResponse({
      content: JSON.stringify({ pass: true, reasoning: "stronger model agreed" }),
    });
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct", {
        judge: { model: "strong/override" },
      });
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    // The override model is what hits the provider...
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe("strong/override");
    // ...and what's stamped on the assertion metadata (shown in the dashboard).
    expect(result).toMatchObject({
      pass: true,
      judge: { model: "strong/override" },
    });
  });

  it("inherits unspecified fields from the base judge config", async () => {
    const fetchMock = stubCapturingJudgeResponse({
      content: JSON.stringify({ pass: true, reasoning: "ok" }),
    });
    defineCheck("quality", async (t) => {
      // Override only the model; baseURL/apiKey should come from judgeConfig.
      await t.judge("answer", "PASS when correct", {
        judge: { model: "strong/override" },
      });
    });

    await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe("strong/override");
    // judgeConfig.baseURL / apiKey flow through callJudge unchanged.
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.headers!["Authorization"]).toBe("Bearer secret");
    expect(init.headers!["Content-Type"]).toBe("application/json");
  });

  it("overrides baseURL and apiKey per call too", async () => {
    const fetchMock = stubCapturingJudgeResponse({
      content: JSON.stringify({ pass: true, reasoning: "ok" }),
    });
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct", {
        judge: {
          model: "strong/override",
          baseURL: "https://other.test/v1",
          apiKey: "other-key",
        },
      });
    });

    await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://other.test/v1/chat/completions");
    expect(init!.headers!["Authorization"]).toBe("Bearer other-key");
  });

  it("uses a per-call override even when no run-level config is set", async () => {
    const fetchMock = stubCapturingJudgeResponse({
      content: JSON.stringify({ pass: true, reasoning: "ok" }),
    });
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct", {
        judge: { model: "only/override" },
      });
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      // No judgeConfig — the override alone must carry the call.
    });

    expect(result).toMatchObject({
      pass: true,
      judge: { model: "only/override" },
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe("only/override");
  });
});

describe("t.judge temperature", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const sentTemperature = async (
    config: JudgeConfig,
    perCall?: { temperature?: number },
  ): Promise<unknown> => {
    const fetchMock = stubCapturingJudgeResponse({
      content: JSON.stringify({ pass: true, reasoning: "ok" }),
    });
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct", perCall ? { judge: perCall } : undefined);
    });
    await runTraceChecks({ snapshot: emptySnapshot, deliverables: {}, judgeConfig: config });
    return JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).temperature;
  };

  it("sends 0 when nothing sets it", async () => {
    expect(await sentTemperature(judgeConfig)).toBe(0);
  });

  it("sends the configured judge.temperature", async () => {
    expect(await sentTemperature({ ...judgeConfig, temperature: 0.6 })).toBe(0.6);
  });

  it("lets a per-call judge.temperature win over the configured one", async () => {
    expect(await sentTemperature({ ...judgeConfig, temperature: 0.6 }, { temperature: 0.2 })).toBe(0.2);
  });

  it("falls back to APO_JUDGE_TEMPERATURE when no config sets it", async () => {
    vi.stubEnv("APO_JUDGE_TEMPERATURE", "0.6");
    expect(await sentTemperature(judgeConfig)).toBe(0.6);
  });

  it("keeps a configured temperature over APO_JUDGE_TEMPERATURE, 0 included", async () => {
    vi.stubEnv("APO_JUDGE_TEMPERATURE", "0.6");
    expect(await sentTemperature({ ...judgeConfig, temperature: 0 })).toBe(0);
  });

  const judgeErrorFor = async (
    config: JudgeConfig,
  ): Promise<{ result: Awaited<ReturnType<typeof runTraceChecks>>[number] | undefined; fetchMock: ReturnType<typeof stubCapturingJudgeResponse> }> => {
    const fetchMock = stubCapturingJudgeResponse({
      content: JSON.stringify({ pass: true, reasoning: "ok" }),
    });
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct");
    });
    const [result] = await runTraceChecks({ snapshot: emptySnapshot, deliverables: {}, judgeConfig: config });
    return { result, fetchMock };
  };

  it.each(["abc", "2.0001", "-0.5", "Infinity"])(
    "records a judge error, without calling the provider, for APO_JUDGE_TEMPERATURE=%s",
    async (raw) => {
      vi.stubEnv("APO_JUDGE_TEMPERATURE", raw);
      const { result, fetchMock } = await judgeErrorFor(judgeConfig);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result?.pass).toBe(false);
      expect(result?.assertions?.[0]?.outcome).toBe("error");
      expect(result?.reasoning).toMatch(/APO_JUDGE_TEMPERATURE must be a number between 0 and 2/);
    },
  );

  it("names judge.temperature when the configured value is out of range", async () => {
    const { result, fetchMock } = await judgeErrorFor({ ...judgeConfig, temperature: 3 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result?.assertions?.[0]?.outcome).toBe("error");
    expect(result?.reasoning).toMatch(/judge\.temperature must be a number between 0 and 2, got 3/);
  });

  it("makes no request at all for a bad value when a second judge is configured", async () => {
    vi.stubEnv("APO_SECOND_JUDGE_MODEL", "typesafe/jev-test");
    vi.stubEnv("APO_JUDGE_TEMPERATURE", "5");
    const { result, fetchMock } = await judgeErrorFor(judgeConfig);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result?.assertions?.[0]?.outcome).toBe("error");
  });

  it("makes no request at all for a bad value in cascade mode", async () => {
    vi.stubEnv("APO_SECOND_JUDGE_MODEL", "typesafe/jev-test");
    const { result, fetchMock } = await judgeErrorFor({ ...judgeConfig, mode: "cascade", temperature: 9 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result?.assertions?.[0]?.outcome).toBe("error");
  });

  it("records the temperature used on the judge metadata", async () => {
    stubCapturingJudgeResponse({ content: JSON.stringify({ pass: true, reasoning: "ok" }) });
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct");
    });
    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig: { ...judgeConfig, temperature: 0.6 },
    });
    expect(result).toMatchObject({ judge: { temperature: 0.6 } });
  });
});

describe("t.judge streaming", () => {
  it("asks for a stream with usage", async () => {
    const fetchMock = stubCapturingJudgeResponse({
      content: JSON.stringify({ pass: true, reasoning: "ok" }),
    });
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct");
    });

    await runTraceChecks({ snapshot: emptySnapshot, deliverables: {}, judgeConfig });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("assembles the verdict from SSE chunks, skipping keepalive comments", async () => {
    const verdict = JSON.stringify({ reasoning: "all positions stated", pass: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          ": ping\n\n",
          // A reasoning model's thinking arrives outside `content`.
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "hmm" } }] })}\n\n`,
          ": ping\n\n",
          `data: ${JSON.stringify({ choices: [{ delta: { content: verdict.slice(0, 20) } }] })}\n`,
          // A chunk boundary inside an SSE line must not lose content.
          `\ndata: ${JSON.stringify({ choices: [{ delta: { content: verdict.slice(20) } }] }).slice(0, 15)}`,
          `${JSON.stringify({ choices: [{ delta: { content: verdict.slice(20) } }] }).slice(15)}\n\n`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 9 } })}\n\n`,
          "data: [DONE]\n\n",
        ]),
      ),
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
      pass: true,
      judge: { response: verdict, tokens: { input: 50, output: 9 } },
    });
    expect(result?.assertions?.[0]?.reasoning).toBe("all positions stated");
  });

  it("retries a stream that carries an error chunk", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([
          ": ping\n\n",
          `data: ${JSON.stringify({ error: { message: "upstream overloaded" } })}\n\n`,
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: '{"reasoning":"ok","pass":true}' } }] })}\n\n`,
          "data: [DONE]\n\n",
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result?.pass).toBe(true);
    expect(result?.assertions?.[0]).toMatchObject({ pass: true, reasoning: "ok" });
  });

  it("cuts a stalled stream on the idle bound and retries it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // First attempt: streaming starts, then only keepalives, never closes —
      // a provider that stalled mid-stream behind a live gateway.
      const stalled = (_url: string, init?: RequestInit): Promise<Response> => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking" } }] })}\n\n: ping\n\n`,
              ),
            );
            init?.signal?.addEventListener("abort", () =>
              controller.error(init.signal!.reason),
            );
          },
        });
        return Promise.resolve(
          new Response(body, { headers: { "content-type": "text/event-stream" } }),
        );
      };
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(stalled)
        .mockResolvedValueOnce(
          sseResponse([
            `data: ${JSON.stringify({ choices: [{ delta: { content: '{"reasoning":"ok","pass":true}' } }] })}\n\n`,
          ]),
        );
      vi.stubGlobal("fetch", fetchMock);

      const pending = callJudge({ values: ["stall-deliverable"], instruction: "x", model: "m" });
      await vi.advanceTimersByTimeAsync(90_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ pass: true, reasoning: "ok" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat keepalive-only silence before the first chunk as a stall", async () => {
    // A reasoning model that doesn't stream its thinking sends only comments
    // until it answers; that silence is the think and must outlast the idle
    // bound.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const encoder = new TextEncoder();
      let answer!: () => void;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(": OPENROUTER PROCESSING\n\n"));
          answer = () => {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: '{"reasoning":"late","pass":true}' }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
              ),
            );
            controller.close();
          };
        },
      });
      const fetchMock = vi.fn(async () =>
        new Response(body, { headers: { "content-type": "text/event-stream" } }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const pending = callJudge({ values: ["slow-thinker"], instruction: "x", model: "m" });
      await vi.advanceTimersByTimeAsync(150_000);
      answer();
      const result = await pending;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ pass: true, reasoning: "late" });
    } finally {
      vi.useRealTimers();
    }
  });

  // A judge that streams its reasoning, one chunk every `everyMs`, and answers once `answer()` is called.
  const reasoningStream = (everyMs: number) => {
    const encoder = new TextEncoder();
    let answer!: () => void;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "still thinking" } }] })}\n\n`;
          controller.enqueue(encoder.encode(chunk));
          const tick = setInterval(() => controller.enqueue(encoder.encode(chunk)), everyMs);
          answer = () => {
            clearInterval(tick);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: '{"reasoning":"long think","pass":true}' }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
              ),
            );
            controller.close();
          };
          init?.signal?.addEventListener("abort", () => {
            clearInterval(tick);
            controller.error(init.signal!.reason);
          });
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    return { fetchMock, answer: () => answer() };
  };

  it("does not cut a judge that is still streaming its reasoning past the first-data window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const { fetchMock, answer } = reasoningStream(30_000);
      vi.stubGlobal("fetch", fetchMock);

      const pending = callJudge({ values: ["long-think"], instruction: "x", model: "m" });
      await vi.advanceTimersByTimeAsync(420_000);
      answer();
      const result = await pending;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ pass: true, reasoning: "long think" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends an attempt that sends no data within APO_JUDGE_TIMEOUT_MS and retries it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubEnv("APO_JUDGE_TIMEOUT_MS", "120000");
    try {
      // Keepalives only, never a data chunk — a provider that died behind a live gateway.
      const silent = (_url: string, init?: RequestInit): Promise<Response> => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": ping\n\n"));
            init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
          },
        });
        return Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
      };
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(silent)
        .mockResolvedValueOnce(
          sseResponse([
            `data: ${JSON.stringify({ choices: [{ delta: { content: '{"reasoning":"ok","pass":true}' } }] })}\n\n`,
          ]),
        );
      vi.stubGlobal("fetch", fetchMock);

      const pending = callJudge({ values: ["never-starts"], instruction: "x", model: "m" });
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ pass: true, reasoning: "ok" });
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it("stops a judge that is still streaming at APO_JUDGE_MAX_DURATION_MS, without a retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubEnv("APO_JUDGE_MAX_DURATION_MS", "600000");
    try {
      const { fetchMock } = reasoningStream(30_000);
      vi.stubGlobal("fetch", fetchMock);

      const pending = callJudge({ values: ["runaway"], instruction: "x", model: "m" });
      const outcome = expect(pending).rejects.toThrow(/still streaming after 600s/);
      await vi.advanceTimersByTimeAsync(600_000);
      await outcome;

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it("finishes on [DONE] even when the server keeps the stream open", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const encoder = new TextEncoder();
      const fetchMock = vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: '{"reasoning":"ok","pass":true}' }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
              ),
            );
            // Never closed.
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await callJudge({ values: ["done-no-close"], instruction: "x", model: "m" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ pass: true, reasoning: "ok" });
      expect(result.unavailable).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a complete verdict even when the reply stopped for length", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: '{"reasoning":"ok","pass":false}' }, finish_reason: "length" }] })}\n\n`,
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callJudge({ values: ["length-but-complete"], instruction: "x", model: "m" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ pass: false, reasoning: "ok" });
    expect(result.unavailable).toBeUndefined();
  });

  it("retries a reply cut off at the length limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: '{"reasoning":"the memo lists' }, finish_reason: "length" }] })}\n\n`,
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: '{"reasoning":"ok","pass":true}' }, finish_reason: "stop" }] })}\n\n`,
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callJudge({ values: ["length-cut"], instruction: "x", model: "m" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ pass: true, reasoning: "ok" });
  });

  it("falls back to a non-streaming request when the endpoint rejects stream fields", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"error":"Unrecognized request argument supplied: stream_options"}', {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ choices: [{ message: { content: '{"reasoning":"ok","pass":true}' } }] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callJudge({ values: ["no-stream-endpoint"], instruction: "x", model: "m" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    expect(retryBody.stream).toBeUndefined();
    expect(retryBody.stream_options).toBeUndefined();
    expect(result).toMatchObject({ pass: true, reasoning: "ok" });
  });

  it("reads a multi-line SSE event and a named error event", async () => {
    const verdict = '{"reasoning":"ok","pass":true}';
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(sseResponse(["event: error\r\ndata: upstream overloaded\r\n\r\n"]))
        .mockResolvedValueOnce(
          sseResponse([
            // One event split across two data lines is joined with "\n".
            `data: {"choices":[{"delta":{"content":${JSON.stringify(verdict)}},\ndata: "finish_reason":"stop"}]}\n\n`,
          ]),
        ),
    );

    const result = await callJudge({ values: ["multi-line"], instruction: "x", model: "m" });

    expect(result).toMatchObject({ pass: true, reasoning: "ok" });
  });

  it("waits out a 429's Retry-After before the retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response("rate limited", { status: 429, headers: { "retry-after": "5" } }),
        )
        .mockResolvedValueOnce(
          Response.json({ choices: [{ message: { content: '{"reasoning":"ok","pass":true}' } }] }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const pending = callJudge({ values: ["rate-limited"], instruction: "x", model: "m" });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ pass: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a stream with no content as a judge error after one retry", async () => {
    const fetchMock = vi.fn(async () => sseResponse([": ping\n\n", "data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result?.reasoning).toContain("empty or truncated");
    expect(result?.assertions?.[0]).toMatchObject({ pass: false, outcome: "error" });
  });
});

describe("t.judge reasoning-loop guard", () => {
  const verdictChunk = (verdict: { reasoning: string; pass: boolean }): string =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(verdict) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

  /**
   * A judge whose reasoning degenerates into "Hmm. " and never ends: the
   * stream stays open until the request is aborted, so only the guard can
   * end this attempt before the idle / runaway bounds.
   */
  const loopingStream = (field: "reasoning_content" | "reasoning" = "reasoning_content") =>
    (_url: string, init?: RequestInit): Promise<Response> => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { [field]: "Let me weigh both readings of the criterion. " } }] })}\n\n`,
            ),
          );
          for (let i = 0; i < 2_000; i++) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { [field]: "Hmm. " } }] })}\n\n`),
            );
          }
          init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
        },
      });
      return Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    };

  it("cuts a looping draw and keeps the retry's verdict", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(loopingStream())
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "The reply names the deadline. Hmm. It does." } }] })}\n\n`,
          verdictChunk({ reasoning: "names the deadline", pass: false }),
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callJudge({ values: ["loop-then-ok"], instruction: "x", model: "m" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ pass: false, reasoning: "names the deadline" });
    expect(result.unavailable).toBeUndefined();
    expect(result.judge.reasoning_loops).toBe(1);
  });

  it("records a judge error with the loop reason, not a FAIL, when the retry loops too", async () => {
    const fetchMock = vi.fn(loopingStream("reasoning"));
    vi.stubGlobal("fetch", fetchMock);
    defineCheck("quality", async (t) => {
      await t.judge("answer", "PASS when correct");
    });

    const [result] = await runTraceChecks({ snapshot: emptySnapshot, deliverables: {}, judgeConfig });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const assertion = result?.assertions?.[0];
    expect(assertion).toMatchObject({ pass: false, outcome: "error" });
    expect(assertion?.reasoning).toMatch(/^Judge reasoning loop/);
    expect(assertion?.reasoning).toContain("on the retry too");
    expect(assertion?.reasoning).toMatch(/"(hmm|mmh|mhm)" repeated 333×/);
    expect(assertion?.judge?.reasoning_loops).toBe(2);
  });

  it("cuts a verdict that loops in the visible content", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: `{"reasoning": "${"no, yes, ".repeat(400)}` } }] })}\n\n`,
        ]),
      )
      .mockResolvedValueOnce(sseResponse([verdictChunk({ reasoning: "ok", pass: true })]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callJudge({ values: ["content-loop"], instruction: "x", model: "m" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ pass: true, judge: { reasoning_loops: 1 } });
  });

  it("leaves a healthy reasoning stream alone", async () => {
    const thinking = Array.from(
      { length: 300 },
      (_, i) => `Point ${i + 1}: the reply ${i % 2 ? "states" : "omits"} item ${i * 7}. ${i % 9 === 0 ? "Hmm. " : ""}`,
    );
    const fetchMock = vi.fn(async () =>
      sseResponse([
        ...thinking.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: t } }] })}\n\n`),
        verdictChunk({ reasoning: "ok", pass: true }),
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callJudge({ values: ["healthy-think"], instruction: "x", model: "m" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ pass: true, reasoning: "ok" });
    expect(result.judge.reasoning_loops).toBeUndefined();
  });

  it("is off with APO_JUDGE_LOOP_GUARD=0", async () => {
    vi.stubEnv("APO_JUDGE_LOOP_GUARD", "0");
    try {
      const fetchMock = vi.fn(async () =>
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Hmm. ".repeat(2_000) } }] })}\n\n`,
          verdictChunk({ reasoning: "ok", pass: true }),
        ]),
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await callJudge({ values: ["guard-off"], instruction: "x", model: "m" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ pass: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("t.judge prompt caching", () => {
  // Regression: the deliverable used to ride in the user message with no
  // cache_control, so every criterion re-billed the whole (often huge)
  // deliverable. It must now be a cacheable system prefix.
  it("puts the deliverable in the system message with an ephemeral cache breakpoint", async () => {
    const fetchMock = stubCapturingJudgeResponse({
      content: JSON.stringify({ pass: true, reasoning: "ok" }),
    });
    defineCheck("quality", async (t) => {
      await t.judge("the big deliverable text", "PASS when correct");
    });

    await runTraceChecks({ snapshot: emptySnapshot, deliverables: {}, judgeConfig });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const system = (body.messages as Array<{ role: string; content: unknown }>).find(
      (m) => m.role === "system",
    )!;

    // System content is structured blocks (Anthropic-style), not a bare string,
    // so a cache breakpoint can be attached to the deliverable.
    expect(Array.isArray(system.content)).toBe(true);
    const blocks = system.content as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    const cached = blocks.find((b) => b.cache_control?.type === "ephemeral");
    expect(cached).toBeDefined();
    // The deliverable lands in the cached block; the instruction must not.
    expect(cached!.text).toContain("the big deliverable text");
    expect(cached!.text).not.toContain("PASS when correct");
  });

  it("keeps only the per-criterion instruction in the user message", async () => {
    const fetchMock = stubCapturingJudgeResponse({
      content: JSON.stringify({ pass: true, reasoning: "ok" }),
    });
    defineCheck("quality", async (t) => {
      await t.judge("deliverable payload", "PASS when the thing holds");
    });

    await runTraceChecks({ snapshot: emptySnapshot, deliverables: {}, judgeConfig });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const user = (body.messages as Array<{ role: string; content: unknown }>).find(
      (m) => m.role === "user",
    )!;
    const userText =
      typeof user.content === "string"
        ? user.content
        : JSON.stringify(user.content);

    expect(userText).toContain("PASS when the thing holds");
    // The large deliverable must NOT be re-sent in the user message.
    expect(userText).not.toContain("deliverable payload");
  });

  it("emits a byte-identical system prefix across criteria judging the same deliverable", async () => {
    const fetchMock = stubCapturingJudgeResponse({
      content: JSON.stringify({ pass: true, reasoning: "ok" }),
    });
    defineCheck("quality", async (t) => {
      await t.judge("shared deliverable", "criterion one");
      await t.judge("shared deliverable", "criterion two");
    });

    await runTraceChecks({ snapshot: emptySnapshot, deliverables: {}, judgeConfig });

    expect(fetchMock.mock.calls).toHaveLength(2);
    const bodies = fetchMock.mock.calls.map((c) =>
      JSON.parse((c[1] as RequestInit).body as string),
    );
    const systemOf = (b: { messages: Array<{ role: string }> }) =>
      JSON.stringify(b.messages.find((m) => m.role === "system"));
    const userTextOf = (b: {
      messages: Array<{ role: string; content: unknown }>;
    }) => {
      const u = b.messages.find((m) => m.role === "user")!;
      return typeof u.content === "string" ? u.content : JSON.stringify(u.content);
    };

    // Same deliverable => byte-identical system prefix => cache hit on call 2.
    expect(systemOf(bodies[0]!)).toBe(systemOf(bodies[1]!));
    // Only the per-criterion instruction differs.
    expect(userTextOf(bodies[0]!)).not.toBe(userTextOf(bodies[1]!));
  });

  it("records the assembled system + user text in judge metadata", async () => {
    stubJudgeResponse({ content: JSON.stringify({ pass: true, reasoning: "ok" }) });
    defineCheck("quality", async (t) => {
      await t.judge("payload here", "PASS when correct");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    // Metadata stays human-readable: system holds the deliverable, user the
    // instruction — so the dashboard can still show what was sent.
    expect(result?.judge?.prompt?.system).toContain("payload here");
    expect(result?.judge?.prompt?.user).toContain("PASS when correct");
  });

  it("surfaces provider cache-token fields in judge metadata", async () => {
    // OpenRouter passes Anthropic's cache_creation_input_tokens /
    // cache_read_input_tokens through in usage. They must reach the metadata
    // so a cache hit/miss is observable in the dashboard.
    stubJudgeResponse({
      content: JSON.stringify({ pass: true, reasoning: "ok" }),
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        cache_creation_input_tokens: 9000,
        cache_read_input_tokens: 0,
      } as never,
    });
    defineCheck("quality", async (t) => {
      await t.judge("payload", "PASS when correct");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(result?.judge?.tokens).toMatchObject({
      input: 10,
      output: 4,
      cache_creation: 9000,
      cache_read: 0,
    });
  });

  it("surfaces OpenRouter-normalized cache fields (prompt_tokens_details)", async () => {
    // OpenRouter normalizes Anthropic cache tokens into the OpenAI-style
    // prompt_tokens_details.{cache_write_tokens, cached_tokens} instead of the
    // Anthropic-native top-level fields. apo supports both routes.
    stubJudgeResponse({
      content: JSON.stringify({ pass: true, reasoning: "ok" }),
      usage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 5987, cache_write_tokens: 0 },
      } as never,
    });
    defineCheck("quality", async (t) => {
      await t.judge("payload", "PASS when correct");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(result?.judge?.tokens).toMatchObject({
      input: 12,
      output: 4,
      cache_creation: 0,
      cache_read: 5987,
    });
  });
});

describe("callJudge prefix serialization", () => {
  // Checks run concurrently (flow-runner uses Promise.all), so without
  // serialization N criteria judging the same deliverable would all fire
  // against a cold cache and mostly miss. Calls sharing a cached prefix must
  // queue: the first warms the provider cache, the rest dispatch after it
  // resolves and hit it.
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  it("does not dispatch a sibling call until the shared-prefix warmer resolves", async () => {
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

    const shared = ["shared-deliverable-body"];
    const p1 = callJudge({ values: shared, instruction: "first", model: "m" });
    await flush();

    // The warmer is in-flight. A concurrent sibling sharing the prefix must
    // NOT have dispatched yet.
    const p2 = callJudge({ values: shared, instruction: "second", model: "m" });
    await flush();
    expect(fetchCount).toBe(1);

    release();
    await Promise.all([p1, p2]);

    // Now the sibling dispatched and hit the warm cache.
    expect(fetchCount).toBe(2);
  });

  it("runs calls with different deliverables concurrently (no false serialization)", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount += 1;
        if (fetchCount === 1) await gateA;
        return Response.json({
          choices: [{ message: { content: '{"pass":true,"reasoning":"ok"}' } }],
        });
      }),
    );

    const pA = callJudge({ values: ["deliverable-A"], instruction: "x", model: "m" });
    await flush();
    const pB = callJudge({ values: ["deliverable-B"], instruction: "x", model: "m" });
    await flush();

    // Different cached prefix => independent => both dispatched concurrently.
    expect(fetchCount).toBe(2);

    releaseA();
    await Promise.all([pA, pB]);
  });

  it("keeps the chain going even when the warmer call rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string);
        // First call (warmer) fails hard; the sibling must still run.
        if (JSON.stringify(body.messages).includes("warmer")) {
          return new Response("boom", { status: 500 });
        }
        return Response.json({
          choices: [{ message: { content: '{"pass":true,"reasoning":"ok"}' } }],
        });
      }),
    );

    const shared = ["shared-deliverable"];
    // Attach the rejection handler synchronously so the warmer's rejected
    // promise never floats unhandled while the sibling is set up.
    const warmerErr = callJudge({
      values: shared,
      instruction: "warmer",
      model: "m",
    }).then(
      () => new Error("expected warmer to reject"),
      (e) => e as Error,
    );
    await flush();
    const sibling = callJudge({ values: shared, instruction: "sibling", model: "m" });

    const [err, result] = await Promise.all([warmerErr, sibling]);
    expect((err as Error).message).toMatch(/Judge API 500/);
    expect(result).toMatchObject({ pass: true });
  });

  it("fans siblings out up to APO_JUDGE_CONCURRENCY once the warmer settles", async () => {
    vi.stubEnv("APO_JUDGE_CONCURRENCY", "3");
    const gates: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((r) => gates.push(r));
        inFlight -= 1;
        return Response.json({
          choices: [{ message: { content: '{"pass":true,"reasoning":"ok"}' } }],
        });
      }),
    );

    const shared = ["fan-out-deliverable"];
    const calls = Array.from({ length: 6 }, (_, i) =>
      callJudge({ values: shared, instruction: `c${i}`, model: "m" }),
    );
    await flush();
    // Only the warmer is out while the cache is cold.
    expect(gates).toHaveLength(1);

    gates.shift()!();
    await flush();
    await flush();
    expect(gates).toHaveLength(3);

    while (gates.length > 0) {
      gates.shift()!();
      await flush();
      await flush();
    }
    await Promise.all(calls);
    expect(peak).toBe(3);
    vi.unstubAllEnvs();
  });
});

/**
 * Stubs `fetch` for a judge call AND captures the request so a test can assert
 * on the model/baseURL/apiKey that actually reached the provider. Returns the
 * mock for direct `.mock.calls` inspection.
 */
function stubCapturingJudgeResponse(args: {
  content: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}): vi.Mock {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({
      choices: [{ message: { content: args.content } }],
      usage: args.usage,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A `text/event-stream` response delivering `chunks` as separate reads. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

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

// Issue #288: the judge metadata records the trace span the context opened
// around the call, so check surfaces can deep-link into the judge's span in
// the trace view. The noop context's sentinel must never be recorded.
describe("t.judge — judge-span trace link (issue #288)", () => {
  /** Minimal JudgeTracer: hands `spanId` to the wrapped fn, tools pass through. */
  function stubTracer(spanId: string) {
    return {
      step: (_options: unknown, fn: (id: string) => Promise<unknown>) =>
        fn(spanId),
      traceTool: (_name: unknown, _params: unknown, fn: () => Promise<unknown>) =>
        fn(),
    };
  }

  it("records the tracer's span id on the judge metadata", async () => {
    stubJudgeResponse({
      content: JSON.stringify({ pass: true, reasoning: "meets the rubric" }),
    });
    defineCheck("quality", async (t) => {
      await t.judge("complete answer", "PASS when complete");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
      judgeTracer: stubTracer("span-j1"),
    });

    expect(result?.judge?.span_id).toBe("span-j1");
    expect(result?.assertions?.[0]?.judge?.span_id).toBe("span-j1");
  });

  it("records no span id when the tracer is the untraced sentinel", async () => {
    stubJudgeResponse({
      content: JSON.stringify({ pass: true, reasoning: "meets the rubric" }),
    });
    defineCheck("quality", async (t) => {
      await t.judge("complete answer", "PASS when complete");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
      judgeTracer: stubTracer("agent-task-untraced-step"),
    });

    expect(result?.judge?.span_id).toBeUndefined();
  });
});

// A check that fires t.judge without awaiting used to end the check before
// the verdict landed — "no assertions recorded", a vacuous pass while the
// judge was still talking. The runner settles tracked judge promises before
// collecting, so the dropped call still counts.
describe("t.judge — un-awaited calls still count", () => {
  it("settles a dropped t.judge promise instead of vacuously passing", async () => {
    stubJudgeResponse({
      content: JSON.stringify({ pass: false, reasoning: "the judge said no" }),
    });
    defineCheck("quality", (t) => {
      // No await — the promise is dropped on purpose.
      void t.judge("answer", "PASS when correct");
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      judgeConfig,
    });

    expect(result?.pass).toBe(false);
    expect(result?.reasoning).toContain("the judge said no");
    expect(result?.assertions?.[0]).toMatchObject({
      pass: false,
      reasoning: "the judge said no",
    });
  });
});
