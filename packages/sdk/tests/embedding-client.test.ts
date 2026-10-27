import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cosineSimilarity,
  createEmbeddingClient,
  embeddingSettingsSignature,
  resolveEmbeddingConfig,
  vectorMagnitude,
} from "../src/agent-task/checks/embedding.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cosineSimilarity", () => {
  it("is 1 for identical, 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("normalizes before comparing — scale-invariant on unnormalized vectors", () => {
    // The same direction at very different magnitudes must stay 1: raw
    // sentence-transformers outputs are not unit-length, so the metric may
    // not assume normalized inputs.
    expect(cosineSimilarity([2, 0], [7, 0])).toBe(1);
  });

  it("returns 0 for a zero-magnitude vector instead of NaN", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(vectorMagnitude([0, 0])).toBe(0);
  });

  it("returns NaN for mismatched lengths so the caller can fail loudly", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBeNaN();
  });
});

describe("embeddingSettingsSignature", () => {
  it("encodes model, dimensionality, and metric semantics", () => {
    expect(embeddingSettingsSignature("openai/text-embedding-3-small", 1536)).toBe(
      "openai/text-embedding-3-small:1536d:cosine:apo-v1",
    );
  });
});

describe("resolveEmbeddingConfig", () => {
  const http = { model: "openai/text-embedding-3-small", baseURL: "https://openrouter.ai/api/v1", apiKey: "k" };

  it("passes a custom embed fn through untouched when no override carries a model", () => {
    const custom = { embed: async () => [[1]] };
    expect(resolveEmbeddingConfig(custom, undefined)).toEqual({ custom });
  });

  it("merges an override field-by-field onto an HTTP base", () => {
    expect(resolveEmbeddingConfig(http, { model: "qwen/qwen3-embedding-8b" })).toEqual({
      config: {
        model: "qwen/qwen3-embedding-8b",
        baseURL: http.baseURL,
        apiKey: http.apiKey,
        dimensions: undefined,
      },
    });
  });

  it("applies a partial override without a model — dimensions merge, provider stays", () => {
    // Mirrors resolveJudgeConfig: a layer that names no model cannot
    // redirect the provider, but its other fields still apply. Dropping the
    // whole layer would misreport the settings the user asked for.
    expect(resolveEmbeddingConfig(http, { dimensions: 256 })).toEqual({
      config: { model: http.model, baseURL: http.baseURL, apiKey: http.apiKey, dimensions: 256 },
    });
    expect(resolveEmbeddingConfig(http, { apiKey: "k2" })?.config?.apiKey).toBe("k2");
  });

  it("an override model replaces a custom fn — per-call HTTP wins", () => {
    const custom = { embed: async () => [[1]] };
    expect(resolveEmbeddingConfig(custom, { model: "m2" })).toEqual({
      config: { model: "m2", baseURL: undefined, apiKey: undefined, dimensions: undefined },
    });
  });

  it("returns undefined when nothing configured a model", () => {
    expect(resolveEmbeddingConfig(undefined, undefined)).toBeUndefined();
    expect(resolveEmbeddingConfig(undefined, { dimensions: 256 })).toBeUndefined();
  });
});

describe("createEmbeddingClient", () => {
  const provider = resolveEmbeddingConfig(
    { model: "test/embed", baseURL: "https://embed.test/v1", apiKey: "k" },
    undefined,
  )!;

  function embeddingsResponse(vectors: number[][], extra: Record<string, unknown> = {}): Response {
    return Response.json({
      data: vectors.map((embedding, index) => ({ index, embedding })),
      model: "test/embed",
      usage: { prompt_tokens: 10 },
      ...extra,
    });
  }

  it("requests both inputs in one batched call and orders by the wire's index field", async () => {
    // Reversed on the wire: data[0] carries index 1. Array-order parsing
    // would silently swap the two vectors — and poison the run cache under
    // the wrong text's key.
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [
          { index: 1, embedding: [0, 1] }, // reference
          { index: 0, embedding: [1, 0] }, // value
        ],
        model: "test/embed",
        usage: { prompt_tokens: 10 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createEmbeddingClient();

    const result = await client.embed(["a", "b"], provider);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(String(init.url ?? fetchMock.mock.calls[0]?.[0])).toBe("https://embed.test/v1/embeddings");
    expect(JSON.parse(String(init.body)).input).toEqual(["a", "b"]);
    expect(result.vectors[0]).toEqual([1, 0]);
    expect(result.vectors[1]).toEqual([0, 1]);
    expect(result.dimensions).toBe(2);
    expect(result.servedModel).toBe("test/embed");
    expect(result.tokens).toEqual({ input: 10 });
  });

  it("does not retry a 400 whose body merely contains the digits 429", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: "maximum 429 inputs per request" }), { status: 400 });
      }),
    );
    await expect(createEmbeddingClient().embed(["a", "b"], provider)).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  it("refuses to guess an endpoint when no baseURL is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const noBase = resolveEmbeddingConfig({ model: "test/embed" }, undefined)!;
    await expect(createEmbeddingClient().embed(["a", "b"], noBase)).rejects.toThrow(
      /no embeddings endpoint configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("embeds a text compared against itself once and stays consistent", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      expect(body.input).toEqual(["gold"]); // deduped: not ["gold", "gold"]
      return embeddingsResponse(body.input.map(() => [1, 0]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await createEmbeddingClient().embed(["gold", "gold"], provider);
    expect(result.vectors).toEqual([[1, 0], [1, 0]]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("embeds a repeated text once — the run-level cache dedupes", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return embeddingsResponse(body.input.map(() => [1, 0]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createEmbeddingClient();

    await client.embed(["shared", "x"], provider);
    await client.embed(["shared", "y"], provider);

    // Second call fetched only "y" — one input, one vector back.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)).input).toEqual(["y"]);
  });

  it("dedupes in-flight fetches: concurrent calls share one request", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return embeddingsResponse(body.input.map(() => [1, 0]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createEmbeddingClient();

    // Two concurrent embeds over a shared text — checks run concurrently in
    // a real run, so the cache must gate in-flight requests, not only
    // resolved vectors.
    await Promise.all([
      client.embed(["shared", "x"], provider),
      client.embed(["shared", "y"], provider),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requested: string[] = fetchMock.mock.calls.flatMap((call) =>
      (JSON.parse(String((call[1] as RequestInit).body)) as { input: string[] }).input,
    );
    expect(requested.sort()).toEqual(["shared", "x", "y"]);
  });

  it("does not mix vectors across configs — the cache key carries the model and endpoint", async () => {
    const other = resolveEmbeddingConfig(
      { model: "other/embed", baseURL: "https://other.test/v1" },
      undefined,
    )!;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return embeddingsResponse(body.input.map(() => [1, 0]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createEmbeddingClient();

    await client.embed(["a", "b"], provider);
    await client.embed(["a", "b"], other);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("collapses newlines to spaces before sending (provider guidance)", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return embeddingsResponse(body.input.map(() => [1, 0]));
    });
    vi.stubGlobal("fetch", fetchMock);
    await createEmbeddingClient().embed(["line1\nline2", "ref"], provider);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).input).toEqual([
      "line1 line2",
      "ref",
    ]);
  });

  it("retries once on 429 honoring Retry-After", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
        return embeddingsResponse([
          [1, 0],
          [1, 0],
        ]);
      }),
    );
    const result = await createEmbeddingClient().embed(["a", "b"], provider);
    expect(calls).toBe(2);
    expect(result.vectors).toHaveLength(2);
  });

  it("retries once without dimensions when a fixed-dimensionality model rejects the param", async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push(body);
        if ("dimensions" in body) {
          return new Response(JSON.stringify({ error: "dimensions not supported" }), { status: 400 });
        }
        return embeddingsResponse([
          [1, 0],
          [1, 0],
        ]);
      }),
    );
    const withDims = resolveEmbeddingConfig(
      { model: "baai/bge-m3", dimensions: 512, baseURL: "https://embed.test/v1" },
      undefined,
    )!;
    const result = await createEmbeddingClient().embed(["a", "b"], withDims);
    expect(calls[0]?.dimensions).toBe(512);
    expect(calls[1]).not.toHaveProperty("dimensions");
    expect(result.dimensions).toBe(2);
  });

  it("surfaces a 402 as a fast billing failure with the provider message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("insufficient credits", { status: 402 })),
    );
    await expect(createEmbeddingClient().embed(["a", "b"], provider)).rejects.toThrow(/402.*insufficient credits/s);
  });

  it("rejects when the provider returns fewer vectors than inputs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => embeddingsResponse([[1, 0]])));
    await expect(createEmbeddingClient().embed(["a", "b"], provider)).rejects.toThrow(/fewer vectors|malformed/);
  });

  it("routes through a custom embed fn without HTTP", async () => {
    const custom = resolveEmbeddingConfig({ embed: async (texts) => texts.map(() => [3, 4]) }, undefined)!;
    const result = await createEmbeddingClient().embed(["a", "b"], custom);
    expect(result.vectors).toEqual([
      [3, 4],
      [3, 4],
    ]);
    expect(result.dimensions).toBe(2);
  });
});
