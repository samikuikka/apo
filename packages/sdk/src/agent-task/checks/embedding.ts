/**
 * Embedding-similarity grading — the deterministic third leg of the check
 * vocabulary (exact/fuzzy matchers, `t.judge`, `t.agent`). Calls any
 * OpenAI-compatible `/embeddings` endpoint (OpenRouter, OpenAI direct, local
 * Ollama/vLLM/LM Studio), L2-normalizes both vectors, and compares with
 * cosine similarity: the same inputs under the same config grade the same
 * every time, unlike an LLM judge.
 *
 * Every verdict records a sacreBLEU-style settings signature
 * (`model:1536d:cosine:apo-v1`) because cosine scales are model-bound: a
 * threshold that means "paraphrase" on one embedding model can mean
 * "unrelated" on another. The signature is the contract.
 */

/** HTTP embedding config — any OpenAI-compatible `/embeddings` endpoint. */
export type EmbeddingConfig = {
  /**
   * Embedding model id in the provider's namespace — e.g.
   * `"openai/text-embedding-3-small"` (OpenRouter) vs
   * `"text-embedding-3-small"` (OpenAI direct). Never reuse a chat model id.
   */
  model: string;
  /** Endpoint base; defaults per provider resolution. Set for local servers. */
  baseURL?: string;
  /** Optional for local endpoints (Ollama and friends need none). */
  apiKey?: string;
  /**
   * Best-effort Matryoshka truncation (models that support it only). The
   * dimensionality actually returned is always what gets recorded and
   * compared — a 400 naming `dimensions` is retried once without it.
   */
  dimensions?: number;
};

/**
 * Full escape hatch: bring any embedder — Cohere/Voyage request dialects, an
 * in-process transformers.js pipeline — as a function. Programmatic layer
 * only (`runTask({ embedding })`); env and task layers carry the HTTP shape.
 */
export type EmbeddingProvider = EmbeddingConfig | { embed: (input: string[]) => Promise<number[][]> };

/** Is this provider the HTTP config shape (vs a custom embed function)? */
export function isEmbeddingHttpConfig(provider: EmbeddingProvider): provider is EmbeddingConfig {
  return typeof (provider as EmbeddingConfig).model === "string";
}

/**
 * Metadata recorded on an assertion graded by embedding similarity. The
 * mirror of `JudgeMetadata`: what graded, under which pinned settings, at
 * what cost — so a similarity number is interpretable years later.
 */
export type EmbeddingMetadata = {
  /** The requested model id, e.g. `openai/text-embedding-3-small`. */
  model: string;
  /** The model the provider reports serving (response `model` field). */
  served_model?: string;
  /** Vector dimensionality actually returned. */
  dimensions: number;
  /** Cosine similarity, rounded to 4 decimals. */
  similarity: number;
  threshold: number;
  metric: "cosine";
  /** `model:1536d:cosine:apo-v1` — everything that can move the number. */
  settings_hash: string;
  tokens?: { input: number };
  latency_ms?: number;
  /** Deep link to this call's EMBEDDING observation in the trace view. */
  span_id?: string;
  /** Short previews of the compared texts, for string-only renderers. */
  value_preview?: string;
  reference_preview?: string;
};

/**
 * Resolved per-call config: the HTTP shape or a custom embed fn, plus the
 * effective model id used in signatures and error messages.
 */
export type ResolvedEmbeddingProvider = {
  config: EmbeddingConfig;
  custom?: undefined;
} | {
  config?: undefined;
  custom: { embed: (input: string[]) => Promise<number[][]> };
};

/**
 * Merge an embedding config override onto a base provider, most specific
 * layer winning — the same field-by-field merge `resolveJudgeConfig` uses,
 * so a partial layer (`{ dimensions }`, `{ apiKey }`) applies over the base
 * instead of being dropped. An override carrying a `model` always yields
 * the HTTP shape (switching away from a custom-embed base); without one, a
 * custom-embed base passes through untouched — dimensions and keys mean
 * nothing to a user-supplied function.
 */
export function resolveEmbeddingConfig(
  provider: EmbeddingProvider | ResolvedEmbeddingProvider | undefined,
  override: Partial<EmbeddingConfig> | undefined,
): ResolvedEmbeddingProvider | undefined {
  const base = resolveEmbeddingProvider(provider);
  if (!override) return base;
  // A custom embed fn has no fields to merge into — a model-less override
  // passes it through untouched; a model override switches to the HTTP
  // shape (baseURL, if missing, fails at request time with guidance rather
  // than silently guessing a provider).
  if (base?.custom && !override.model) return base;
  const baseConfig = base?.config;
  // Model gates the layer, exactly as in resolveJudgeConfig: a layer that
  // names no model cannot redirect an HTTP base to another provider, but
  // its other fields still merge.
  if (!override.model && !baseConfig) return undefined;
  return {
    config: {
      model: override.model ?? baseConfig!.model,
      baseURL: override.baseURL ?? baseConfig?.baseURL,
      apiKey: override.apiKey ?? baseConfig?.apiKey,
      dimensions: override.dimensions ?? baseConfig?.dimensions,
    },
  };
}

/** Normalize a raw provider (HTTP shape or custom fn) to the resolved form. */
function resolveEmbeddingProvider(
  provider: EmbeddingProvider | ResolvedEmbeddingProvider | undefined,
): ResolvedEmbeddingProvider | undefined {
  if (!provider) return undefined;
  if ("config" in provider || "custom" in provider) return provider;
  return isEmbeddingHttpConfig(provider) ? { config: provider } : { custom: provider };
}

/**
 * The embeddings endpoint could not be reached or returned no usable
 * response — no score exists. The caller records `outcome: "error"`,
 * mirroring `JudgeUnavailableError`: an unreachable grader is not a FAIL.
 */
export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingUnavailableError";
  }
}

export type EmbeddingCallResult = {
  vectors: number[][];
  /** The provider-reported `model` field, when present. */
  servedModel?: string;
  dimensions: number;
  tokens?: { input: number };
  /** Present when this call fetched fresh vectors; absent on full cache hits. */
  latencyMs?: number;
};

type CacheKey = string;

/**
 * Create a run-scoped embedding client: one shared vector cache so a
 * reference reused across checks is embedded once, plus the retry/backoff
 * policy for a single request. The cache key carries every setting that
 * selects a different vector space (model, endpoint, requested dimensions)
 * — vectors from different configs must never mix in one comparison.
 * In-flight fetches are deduplicated too: checks run concurrently, and two
 * checks embedding the same reference must share one request, not race past
 * each other into two.
 */
export function createEmbeddingClient(): EmbeddingClient {
  const resolved = new Map<CacheKey, number[]>();
  const inflight = new Map<CacheKey, Promise<number[]>>();

  return {
    async embed(texts, provider) {
      const inputs = texts.map((text) => text.replace(/\r?\n/g, " "));
      const keyed = inputs.map((text) => ({ text, key: cacheKeyFor(text, provider) }));

      // Fetch every text that is neither resolved nor already in flight,
      // deduplicated by key (a call grading a text against itself would
      // otherwise orphan one in-flight promise, and a rejected orphan
      // crashes the process under Node's default unhandled-rejection mode),
      // in one batched request; each text gets its own inflight promise
      // resolving from the shared fetch. Metadata (tokens/latency) is
      // attributed only to the calls that initiated a fetch — a pure
      // cache/inflight hit reports none, because it made no request.
      const seen = new Set<CacheKey>();
      const needFetch = keyed.filter(({ key }) => {
        if (resolved.has(key) || inflight.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      let fetchedMeta: Omit<EmbeddingCallResult, "vectors"> | undefined;
      if (needFetch.length > 0) {
        const fetchPromise = (async () => fetchEmbeddings(needFetch.map((n) => n.text), provider))();
        for (let i = 0; i < needFetch.length; i++) {
          const promise = fetchPromise.then((fetched) => {
            fetchedMeta = {
              dimensions: fetched.dimensions,
              ...(fetched.servedModel !== undefined ? { servedModel: fetched.servedModel } : {}),
              ...(fetched.tokens !== undefined ? { tokens: fetched.tokens } : {}),
              ...(fetched.latencyMs !== undefined ? { latencyMs: fetched.latencyMs } : {}),
            };
            return fetched.vectors[i];
          });
          inflight.set(needFetch[i].key, promise);
        }
        // Cleanup after settle: any late reader either holds the promise or
        // finds the vector in `resolved` (set before cleanup, below).
        void Promise.allSettled(needFetch.map(({ key }) => inflight.get(key)!)).then(() => {
          for (const { key } of needFetch) inflight.delete(key);
        });
      }

      const vectors = await Promise.all(
        keyed.map(async ({ key }) => {
          const inFlight = inflight.get(key);
          if (inFlight !== undefined) {
            const vector = await inFlight;
            resolved.set(key, vector);
            return vector;
          }
          const cached = resolved.get(key);
          if (cached !== undefined) return cached;
          throw new EmbeddingUnavailableError("embedding vector vanished — concurrent cache race");
        }),
      );
      const dims = vectors[0]!.length;
      if (vectors.some((v) => v.length !== dims)) {
        throw new EmbeddingUnavailableError("provider returned vectors of mixed dimensionality");
      }
      return {
        vectors,
        dimensions: dims,
        ...(fetchedMeta?.servedModel !== undefined ? { servedModel: fetchedMeta.servedModel } : {}),
        ...(fetchedMeta?.tokens !== undefined ? { tokens: fetchedMeta.tokens } : {}),
        ...(fetchedMeta?.latencyMs !== undefined ? { latencyMs: fetchedMeta.latencyMs } : {}),
      };
    },
  };
}

function cacheKeyFor(text: string, provider: ResolvedEmbeddingProvider): CacheKey {
  if (provider.custom) return `custom|${text}`;
  const c = provider.config!;
  return `${c.model}|${c.baseURL ?? ""}|${c.dimensions ?? "auto"}|${text}`;
}

/** One embeddings request with the retry policy; never touches the cache. */
async function fetchEmbeddings(
  inputs: string[],
  provider: ResolvedEmbeddingProvider,
): Promise<EmbeddingCallResult> {
  const startedAt = Date.now();
  if (provider.custom) {
    const vectors = await provider.custom.embed(inputs);
    if (!Array.isArray(vectors) || vectors.length !== inputs.length) {
      throw new EmbeddingUnavailableError(
        `custom embed function returned ${vectors?.length ?? 0} vectors for ${inputs.length} inputs`,
      );
    }
    return { vectors, dimensions: vectors[0]?.length ?? 0, latencyMs: Date.now() - startedAt };
  }

  const config = provider.config!;
  const call = (omitDimensions: boolean) =>
    requestEmbeddings(config, inputs, omitDimensions);
  // A 400 that names `dimensions` (fixed-dimensionality models reject it) is
  // retried once without it — best-effort by design; the returned
  // dimensionality is what gets recorded and compared.
  const first = await callWithRetry(() => call(false));
  const result =
    first.kind === "rejected-dimensions"
      ? await callWithRetry(() => call(true))
      : first;
  if (result.kind !== "ok") throw new Error(result.message);
  return {
    vectors: result.vectors,
    ...(result.servedModel ? { servedModel: result.servedModel } : {}),
    dimensions: result.vectors[0]?.length ?? 0,
    ...(result.tokens ? { tokens: result.tokens } : {}),
    latencyMs: Date.now() - startedAt,
  };
}

type EmbeddingsResponse =
  | { kind: "ok"; vectors: number[][]; servedModel?: string; tokens?: { input: number } }
  | { kind: "rejected-dimensions"; message: string }
  | { kind: "error"; status?: number; message: string };

/** One attempt + the single 429 retry honoring Retry-After. */
async function callWithRetry(call: () => Promise<EmbeddingsResponse>): Promise<EmbeddingsResponse> {
  const first = await call();
  // Gate on the status field, not the message: gateway error bodies echo
  // request params, and "429" inside a 400 body ("max 429 inputs") would
  // otherwise buy a pointless retry on a permanent error.
  if (first.kind !== "error" || first.status !== 429) return first;
  const retryAfter = Number(first.message.match(/retry-after (\d+)/)?.[1] ?? 1);
  await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter, 10) * 1000));
  return call();
}

async function requestEmbeddings(
  config: EmbeddingConfig,
  inputs: string[],
  omitDimensions: boolean,
): Promise<EmbeddingsResponse> {
  if (!config.baseURL) {
    // Never guess a host: a bare { model } override reaching here would send
    // an unauthenticated request to a provider the user never named.
    return {
      kind: "error",
      message:
        "no embeddings endpoint configured — set APO_EMBEDDING_BASE_URL (or pass baseURL), e.g. https://openrouter.ai/api/v1 or a local server like http://localhost:11434/v1",
    };
  }
  const url = `${config.baseURL.replace(/\/$/, "")}/embeddings`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        input: inputs,
        ...(omitDimensions ? {} : config.dimensions !== undefined ? { dimensions: config.dimensions } : {}),
      }),
    });
  } catch (error) {
    return { kind: "error", message: `embeddings endpoint unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (response.status === 400) {
    const body = await response.text();
    if (/dimensions/i.test(body)) return { kind: "rejected-dimensions", message: body };
    return { kind: "error", status: 400, message: `embeddings request rejected (400): ${body}` };
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    return { kind: "error", status: 429, message: `embeddings rate-limited (429), retry-after ${retryAfter ?? 1}` };
  }
  if (!response.ok) {
    const body = await response.text();
    return { kind: "error", status: response.status, message: `embeddings request failed (${response.status}): ${body.slice(0, 500)}` };
  }

  const body = (await response.json()) as {
    data?: Array<{ index?: number; embedding?: unknown }>;
    model?: string;
    usage?: { prompt_tokens?: number };
  };
  const data = body.data;
  if (!Array.isArray(data) || data.length !== inputs.length) {
    return { kind: "error", message: `embeddings response malformed: expected ${inputs.length} vectors, got ${data?.length ?? "none"}` };
  }
  // Order by the wire's `index` field, not array position — the field exists
  // precisely because gateways and batch paths may return vectors out of
  // order, and a swapped vector silently poisons the run cache under the
  // wrong text's key. Providers that omit `index` fall back to position.
  const vectors: number[][] = Array.from({ length: data.length });
  data.forEach((item, position) => {
    const vector = item.embedding;
    if (!Array.isArray(vector) || vector.some((v) => typeof v !== "number")) {
      throw new EmbeddingUnavailableError("embeddings response malformed: a returned embedding is not a number array");
    }
    const slot = typeof item.index === "number" && item.index >= 0 && item.index < data.length
      ? item.index
      : position;
    vectors[slot] = vector as number[];
  });
  if (vectors.some((v) => v === undefined)) {
    return { kind: "error", message: "embeddings response malformed: index field named a slot outside the response" };
  }
  return {
    kind: "ok",
    vectors,
    ...(typeof body.model === "string" ? { servedModel: body.model } : {}),
    ...(typeof body.usage?.prompt_tokens === "number" ? { tokens: { input: body.usage.prompt_tokens } } : {}),
  };
}

/**
 * Cosine similarity of two vectors, L2-normalizing first — identical result
 * on already-normalized providers (OpenAI), correct on unnormalized ones
 * (raw sentence-transformers served via OpenAI-compatible gateways). A
 * zero-magnitude vector has no direction: similarity 0, per the guard every
 * surveyed framework ships.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return Number.NaN;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Euclidean length of a vector — lets callers name a zero-magnitude case. */
export function vectorMagnitude(v: readonly number[]): number {
  let sum = 0;
  for (const x of v) sum += x * x;
  return Math.sqrt(sum);
}

/** The run-scoped embedding client surface, for threading through contexts. */
export type EmbeddingClient = {
  embed: (texts: string[], provider: ResolvedEmbeddingProvider) => Promise<EmbeddingCallResult>;
};

/**
 * The recorded settings signature: everything that can move the number.
 * `apo-v1` is the grading-semantics version (model + returned dims + cosine
 * on L2-normalized vectors + newline-collapsed inputs); bump it if
 * preprocessing or the metric ever change, so old signatures stay honest.
 */
export function embeddingSettingsSignature(model: string, dimensions: number): string {
  return `${model}:${dimensions}d:cosine:apo-v1`;
}
