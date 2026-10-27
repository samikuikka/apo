import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineCheck,
  resetFlowChecks,
  runTraceChecks,
} from "../src/agent-task/checks/flow-runner.ts";
import { createEmbeddingClient } from "../src/agent-task/checks/embedding.ts";
import { equals } from "../src/agent-task/checks/matchers.ts";
import type { EmbeddingRuntime } from "../src/agent-task/checks/t.ts";
import type { TraceProjectionSnapshot } from "../src/agent-task/trace-projection/types.ts";

// Semantic checks read no trace evidence — an observations-less snapshot is
// the honest minimal fixture (same as the judge tests).
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

/**
 * Fresh embedding runtime per test: the run-scoped client's vector cache is
 * a feature within one run, but across tests it would freeze the first
 * test's vectors into every later one.
 */
function freshRuntime(): EmbeddingRuntime {
  return {
    provider: {
      config: { model: "test/embed", baseURL: "https://embed.test/v1", apiKey: "k" },
    },
    client: createEmbeddingClient(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetFlowChecks();
});

/**
 * Stub the embeddings endpoint with fixed vectors per input text, so a
 * test's cosine is chosen by construction: `vectors[i]` grades `texts[i]`.
 */
function stubEmbeddings(textsToVectors: Record<string, number[]>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({
        data: body.input.map((text, index) => ({ index, embedding: textsToVectors[text] })),
        model: "test/embed",
        usage: { prompt_tokens: 9 },
      });
    }),
  );
}

describe("t.semantic", () => {
  it("records a passing assertion with score, threshold, and settings signature", async () => {
    stubEmbeddings({ answer: [1, 0], gold: [1, 0] });
    defineCheck("paraphrase", async (t) => {
      await t.semantic("answer", "gold", { threshold: 0.8 });
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      embedding: freshRuntime(),
    });

    expect(result).toMatchObject({
      id: "paraphrase",
      pass: true,
      evaluator_type: "embedding",
      embedding: {
        model: "test/embed",
        served_model: "test/embed",
        dimensions: 2,
        similarity: 1,
        threshold: 0.8,
        metric: "cosine",
        settings_hash: "test/embed:2d:cosine:apo-v1",
        tokens: { input: 9 },
      },
    });
    const assertion = result?.assertions?.[0];
    expect(assertion).toMatchObject({
      pass: true,
      evaluator_type: "embedding",
      expected: "cosine ≥ 0.8000 (test/embed:2d)",
      received: 1,
    });
    // A passing check's summary carries the score line, not just "passed".
    expect(result?.reasoning).toContain("semantic similarity 1.0000 ≥ 0.8000");
  });

  it("fails below the threshold with the arithmetic and delta in the message", async () => {
    // cos([1,0], [0,1]) = 0 — unrelated texts.
    stubEmbeddings({ answer: [1, 0], gold: [0, 1] });
    defineCheck("unrelated", async (t) => {
      await t.semantic("answer", "gold", { threshold: 0.5 });
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      embedding: freshRuntime(),
    });

    expect(result?.pass).toBe(false);
    expect(result?.reasoning).toContain("semantic similarity 0.0000 < 0.5000 (delta -0.5000)");
    expect(result?.assertions?.[0]?.received).toBe(0);
  });

  it("flags verdicts within 0.02 of the threshold as marginal", async () => {
    // cos([1,0], [1,1]) ≈ 0.7071 — 0.0071 above the threshold.
    stubEmbeddings({ answer: [1, 0], gold: [1, 1] });
    defineCheck("near-threshold", async (t) => {
      await t.semantic("answer", "gold", { threshold: 0.7 });
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      embedding: freshRuntime(),
    });

    expect(result?.pass).toBe(true);
    expect(result?.reasoning).toContain("marginal");
    expect(result?.reasoning).toContain("within 0.02 of the threshold");
  });

  it("does not flag verdicts outside the marginal band", async () => {
    stubEmbeddings({ answer: [1, 0], gold: [1, 0] });
    defineCheck("clear-pass", async (t) => {
      await t.semantic("answer", "gold", { threshold: 0.5 });
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      embedding: freshRuntime(),
    });

    expect(result?.reasoning).not.toContain("marginal");
  });

  it("pins the marginal band boundary: 0.019 inside, 0.021 outside", async () => {
    // cos([1,0],[1,x]) = 1/√(1+x²). x≈0.0314 → 0.99951 (rounds 0.9995,
    // delta 0.0005)… pick exact deltas instead: threshold 0.98 with scores
    // 0.999 (delta 0.019 → marginal) and 0.959 (delta 0.021 → not).
    stubEmbeddings({
      near: [1, 0],
      // cos = 0.999 → choose [1, 0.0447]: 1/√(1+0.002) ≈ 0.999
      "ref-near": [1, 0.0447],
      far: [1, 0],
      // cos = 0.959 → [1, 0.296]: 1/√(1.0876) ≈ 0.959
      "ref-far": [1, 0.296],
    });
    defineCheck("inside-band", async (t) => {
      await t.semantic("near", "ref-near", { threshold: 0.98, label: "inside" });
    });
    const [inside] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      embedding: freshRuntime(),
    });
    resetFlowChecks();
    defineCheck("outside-band", async (t) => {
      await t.semantic("far", "ref-far", { threshold: 0.98, label: "outside" });
    });
    const [outside] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      embedding: freshRuntime(),
    });

    expect(inside?.reasoning).toContain("marginal");
    expect(outside?.reasoning).not.toContain("marginal");
  });

  it("names a zero-magnitude vector in the reasoning instead of NaN-ing", async () => {
    stubEmbeddings({ empty: [0, 0], gold: [1, 0] });
    defineCheck("zero-vector", async (t) => {
      await t.semantic("empty", "gold", { threshold: 0.5 });
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      embedding: freshRuntime(),
    });

    expect(result?.pass).toBe(false);
    expect(result?.reasoning).toContain("zero-magnitude vector");
    expect(result?.embedding?.similarity).toBe(0);
  });

  it("records an invalid threshold as an authoring failure without calling the endpoint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    defineCheck("bad-threshold", async (t) => {
      await t.semantic("answer", "gold", { threshold: Number.NaN });
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      embedding: freshRuntime(),
    });

    expect(result?.pass).toBe(false);
    expect(result?.reasoning).toContain("threshold must be a finite number in [0, 1]");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records setup guidance as an error — never a vacuous pass — when no model is configured", async () => {
    defineCheck("unconfigured", async (t) => {
      await t.semantic("answer", "gold", { threshold: 0.7 });
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
    });

    expect(result?.pass).toBe(false);
    expect(result?.outcome).toBe("error");
    expect(result?.reasoning).toContain("No embedding model configured");
    expect(result?.reasoning).toContain("APO_EMBEDDING_MODEL");
  });

  it("records an unreachable endpoint as outcome error, distinct from a FAIL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    defineCheck("endpoint-down", async (t) => {
      await t.semantic("answer", "gold", { threshold: 0.7 });
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      embedding: freshRuntime(),
    });

    expect(result?.pass).toBe(false);
    expect(result?.outcome).toBe("error");
    expect(result?.reasoning).toContain("embedding check failed");
    expect(result?.reasoning).toContain("500");
  });

  it("is deterministic: identical input and config produce an identical verdict across runs", async () => {
    stubEmbeddings({ answer: [1, 0], gold: [1, 1] });
    const run = async () => {
      resetFlowChecks();
      defineCheck("stable", async (t) => {
        await t.semantic("answer", "gold", { threshold: 0.7 });
      });
      const [result] = await runTraceChecks({
        snapshot: emptySnapshot,
        deliverables: {},
        embedding: freshRuntime(),
      });
      return { pass: result?.pass, similarity: result?.embedding?.similarity };
    };

    expect(await run()).toEqual(await run());
  });

  it("shares the vector cache across checks — a reused reference is embedded once", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({
        data: body.input.map((text, index) => ({ index, embedding: [1, 0] })),
        model: "test/embed",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    defineCheck("first", async (t) => {
      await t.semantic("a", "shared gold", { threshold: 0.5 });
    });
    defineCheck("second", async (t) => {
      await t.semantic("b", "shared gold", { threshold: 0.5 });
    });

    await runTraceChecks({ snapshot: emptySnapshot, deliverables: {}, embedding: freshRuntime() });

    // 2 checks × 2 texts, but "shared gold" fetched once → 3 inputs total.
    const requested: string[] = fetchMock.mock.calls.flatMap((call) =>
      (JSON.parse(String((call[1] as RequestInit).body)) as { input: string[] }).input,
    );
    expect(requested).toEqual(["a", "shared gold", "b"]);
  });

  it("marks a check mixing deterministic and semantic assertions as mixed", async () => {
    stubEmbeddings({ answer: [1, 0], gold: [1, 0] });
    defineCheck("mixed-kinds", async (t) => {
      t.check(1, equals(1));
      await t.semantic("answer", "gold", { threshold: 0.5 });
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      embedding: freshRuntime(),
    });

    expect(result?.evaluator_type).toBe("mixed");
  });

  it("merges a per-call model override onto the threaded config", async () => {
    stubEmbeddings({ answer: [1, 0], gold: [1, 0] });
    defineCheck("escalated", async (t) => {
      await t.semantic("answer", "gold", {
        threshold: 0.5,
        embedding: { model: "stronger/embed", dimensions: 256 },
      });
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      embedding: freshRuntime(),
    });

    expect(result?.embedding?.model).toBe("stronger/embed");
    expect(result?.embedding?.settings_hash).toContain("stronger/embed");
  });

  it("traces the call as an EMBEDDING observation and records the numeric score", async () => {
    stubEmbeddings({ answer: [1, 0], gold: [1, 0] });
    const step = vi.fn(
      async (_options: unknown, fn: (id: string) => Promise<unknown>) => fn("span-1"),
    );
    const score = vi.fn(async () => undefined);
    defineCheck("traced", async (t) => {
      await t.semantic("answer", "gold", { threshold: 0.5 });
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      embedding: { ...freshRuntime(), tracer: { step, score } },
    });

    expect(step).toHaveBeenCalledOnce();
    const stepOptions = step.mock.calls[0]?.[0] as { observation_type?: string; model?: string };
    expect(stepOptions.observation_type).toBe("EMBEDDING");
    expect(stepOptions.model).toBe("test/embed");
    expect(score).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "semantic_similarity",
        value: 1,
        dataType: "NUMERIC",
        source: "EVAL",
        observationId: "span-1",
      }),
    );
    expect(result?.embedding?.span_id).toBe("span-1");
  });

  it("a score-record failure never fails the check it scored", async () => {
    stubEmbeddings({ answer: [1, 0], gold: [1, 0] });
    const step = vi.fn(async (_options: unknown, fn: (id: string) => Promise<unknown>) => fn("span-2"));
    const score = vi.fn(async () => {
      throw new Error("score store down");
    });
    defineCheck("scored-anyway", async (t) => {
      await t.semantic("answer", "gold", { threshold: 0.5 });
    });

    const [result] = await runTraceChecks({
      snapshot: emptySnapshot,
      deliverables: {},
      embedding: { ...freshRuntime(), tracer: { step, score } },
    });

    expect(score).toHaveBeenCalledOnce();
    expect(result?.pass).toBe(true);
    expect(result?.embedding?.span_id).toBe("span-2");
  });
});
