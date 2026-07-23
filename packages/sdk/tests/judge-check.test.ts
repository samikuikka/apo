import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineCheck,
  resetFlowChecks,
  runTraceChecks,
} from "../src/agent-task/checks/flow-runner.ts";
import { callJudge } from "../src/agent-task/checks/judge.ts";
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
