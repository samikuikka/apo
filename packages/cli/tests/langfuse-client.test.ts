import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MAX_OBSERVATIONS,
  DETAIL_MAX_RETRIES,
  fetchLangfuseTrace,
  LangfuseEmptyTraceError,
  type LangfuseConnectorConfig,
  pollLangfuseTrace,
  resolveConnectorConfig,
} from "../src/lib/trace-sources/langfuse-client.ts";

const TRACE_ID = "8f38c27a2c4b4bafb87a78e3a3d62b90";
const DEFAULT_HOST = "https://cloud.langfuse.com";

type FetchCall = {
  url: string;
  init?: RequestInit;
};

type ListPage = { status?: number; body?: unknown; headers?: Record<string, string> };

// captureFetch routes requests by URL:
//   - `/api/public/v2/observations` (LIST)  -> drained from the `pages` queue
//   - `/api/public/observations/{id}` (DETAIL) -> looked up by id in `details`
// The detail endpoint is the source of truth for content fields, so every
// successful import now fires N detail requests after the list pages. Routing
// by URL (instead of call order) keeps the detail responses order-independent.
function captureFetch(
  pages: ListPage[],
  details: Record<string, unknown> = {},
): { calls: FetchCall[]; listCalls: FetchCall[]; detailCalls: FetchCall[]; mock: ReturnType<typeof vi.spyOn> } {
  const calls: FetchCall[] = [];
  const listCalls: FetchCall[] = [];
  const detailCalls: FetchCall[] = [];
  const pageQueue = [...pages];
  let lastPage: ListPage | undefined;
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });

    const detailMatch = url.match(/\/api\/public\/observations\/([^/?]+)/);
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]!);
      detailCalls.push({ url, init });
      if (!(id in details)) throw new Error(`captureFetch: no detail mock for observation ${id}`);
      return new Response(JSON.stringify(details[id] ?? {}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    listCalls.push({ url, init });
    const next = pageQueue.shift();
    if (next) lastPage = next;
    const lp = lastPage ?? { status: 404, body: {} };
    return new Response(JSON.stringify(lp.body ?? {}), {
      status: lp.status ?? 200,
      headers: { "Content-Type": "application/json", ...lp.headers },
    });
  });
  return { calls, listCalls, detailCalls, mock };
}

function basicConfig(over: Partial<LangfuseConnectorConfig> = {}): LangfuseConnectorConfig {
  return {
    host: over.host ?? DEFAULT_HOST,
    publicKey: over.publicKey ?? "pk-lf-test",
    secretKey: over.secretKey ?? "sk-lf-test",
    maxObservations: over.maxObservations ?? DEFAULT_MAX_OBSERVATIONS,
  };
}

function obsRow(over: Partial<{ id: string; traceId: string }> = {}): unknown {
  return {
    id: over.id ?? "obs-1",
    traceId: over.traceId ?? TRACE_ID,
    type: "SPAN",
    startTime: "2026-07-22T10:00:00.000000Z",
  };
}

function page(body: unknown[], meta: { cursor?: string | null } = {}): unknown {
  return { data: body, meta };
}

// A *bare* list row: the v2 LIST endpoint now returns only summary fields.
// Crucially it is MISSING name/input/output/metadata/model — those only live
// on the detail endpoint. This mirrors the real regression from issue #25.
function bareListRow(over: Partial<{ id: string; traceId: string; type: string }> = {}): unknown {
  return {
    id: over.id ?? "obs-1",
    traceId: over.traceId ?? TRACE_ID,
    type: over.type ?? "GENERATION",
    parentObservationId: null,
    startTime: "2026-07-22T10:00:00.000000Z",
    endTime: "2026-07-22T10:00:01.000000Z",
    usageDetails: { input: 100, output: 50 },
    totalCost: 0.012,
  };
}

// The full payload returned by GET /api/public/observations/{id}. Includes
// every content-bearing field the list omits (name/input/output/metadata/model).
function detailBody(over: Record<string, unknown> = {}): unknown {
  const pick = (key: string, fallback: unknown): unknown =>
    key in over ? over[key] : fallback;
  return {
    id: pick("id", "obs-1"),
    traceId: pick("traceId", TRACE_ID),
    type: pick("type", "GENERATION"),
    parentObservationId: pick("parentObservationId", null),
    startTime: pick("startTime", "2026-07-22T10:00:00.000000Z"),
    endTime: pick("endTime", "2026-07-22T10:00:01.000000Z"),
    name: pick("name", "agent-llm-call"),
    level: pick("level", "DEFAULT"),
    input: pick("input", JSON.stringify({ messages: [{ role: "user", content: "hi" }] })),
    output: pick("output", JSON.stringify({ messages: [{ role: "assistant", content: "hello" }] })),
    metadata: pick("metadata", JSON.stringify({ request_id: "req-1" })),
    model: pick("model", "claude-opus-4-6"),
    usageDetails: pick("usageDetails", { input: 100, output: 50 }),
  };
}

beforeEach(() => {
  vi.stubEnv("LANGFUSE_HOST", "");
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function withKeys(publicKey = "pk-lf-test", secretKey = "sk-lf-test"): void {
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", publicKey);
  vi.stubEnv("LANGFUSE_SECRET_KEY", secretKey);
}

describe("resolveConnectorConfig", () => {
  it("rejects missing credentials before any network I/O", () => {
    expect(() => resolveConnectorConfig({})).toThrow(/LANGFUSE_PUBLIC_KEY/i);
    withKeys("pk", "");
    expect(() => resolveConnectorConfig({})).toThrow(/LANGFUSE_SECRET_KEY/i);
    withKeys("", "sk");
    expect(() => resolveConnectorConfig({})).toThrow(/LANGFUSE_PUBLIC_KEY/i);
  });

  it("never sends the keys into errors that mention only one missing var", () => {
    withKeys("pk-leak-me", "");
    try {
      resolveConnectorConfig({});
      throw new Error("expected throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain("pk-leak-me");
    }
  });

  it("applies host precedence: flag > env > default", () => {
    withKeys();
    const a = resolveConnectorConfig({});
    expect(a.host).toBe(DEFAULT_HOST);

    vi.stubEnv("LANGFUSE_HOST", "https://us.langfuse.com");
    const b = resolveConnectorConfig({});
    expect(b.host).toBe("https://us.langfuse.com");

    const c = resolveConnectorConfig({ hostFlag: "https://staging.langfuse.com" });
    expect(c.host).toBe("https://staging.langfuse.com");
  });

  it("normalizes host: drops trailing slash, path, query, fragment, lowercases scheme/host", () => {
    withKeys();
    const c = resolveConnectorConfig({
      hostFlag: "HTTPS://Cloud.Langfuse.com:8443/some/path?x=1#frag",
    });
    expect(c.host).toBe("https://cloud.langfuse.com:8443");
    // Default ports are dropped per WHATWG URL spec.
    const d = resolveConnectorConfig({
      hostFlag: "HTTPS://Cloud.Langfuse.com:443/",
    });
    expect(d.host).toBe("https://cloud.langfuse.com");
  });

  it("rejects embedded credentials in the host", () => {
    withKeys();
    expect(() =>
      resolveConnectorConfig({ hostFlag: "https://user:pass@cloud.langfuse.com" }),
    ).toThrow(/credential/i);
  });

  it("rejects non-http(s) schemes and other malformed input", () => {
    withKeys();
    expect(() => resolveConnectorConfig({ hostFlag: "ftp://cloud.langfuse.com" })).toThrow(/scheme|http/i);
    expect(() => resolveConnectorConfig({ hostFlag: "not-a-url" })).toThrow();
  });

  it("respects --max-observations within range 1..50000", () => {
    withKeys();
    const ok = resolveConnectorConfig({ maxObservationsFlag: "1234" });
    expect(ok.maxObservations).toBe(1234);

    expect(() => resolveConnectorConfig({ maxObservationsFlag: "0" })).toThrow(/max-observations/i);
    expect(() => resolveConnectorConfig({ maxObservationsFlag: "50001" })).toThrow(/max-observations/i);
    expect(() => resolveConnectorConfig({ maxObservationsFlag: "not-a-number" })).toThrow(/max-observations/i);
  });
});

describe("fetchLangfuseTrace pagination", () => {
  beforeEach(() => {
    withKeys();
  });

  it("follows cursors until meta.cursor is absent and accumulates all rows", async () => {
    const { listCalls } = captureFetch(
      [
        { body: page([obsRow({ id: "a" }), obsRow({ id: "b" })], { cursor: "cursor-1" }) },
        { body: page([obsRow({ id: "c" })], { cursor: "cursor-2" }) },
        { body: page([obsRow({ id: "d" })], { cursor: null }) },
      ],
      {
        a: detailBody({ id: "a" }),
        b: detailBody({ id: "b" }),
        c: detailBody({ id: "c" }),
        d: detailBody({ id: "d" }),
      },
    );

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig());

    // 3 list pages; the 4 detail hydrations are routed separately.
    expect(listCalls).toHaveLength(3);
    expect(graph.sourceHost).toBe(DEFAULT_HOST);
    expect(graph.sourceTraceId).toBe(TRACE_ID);
    expect(graph.observations.map((o) => o.id)).toEqual(["a", "b", "c", "d"]);

    // Every LIST request carries the same traceId, full field list, and Basic auth.
    // parseIoAsJson must NOT be sent: Langfuse Cloud removed it from the v2
    // observations endpoint and now 400s on it. I/O is parsed client-side.
    for (const { url, init } of listCalls) {
      expect(url).toContain("/api/public/v2/observations");
      expect(url).toContain(`traceId=${TRACE_ID}`);
      expect(url).toContain("fields=");
      expect(url).not.toContain("parseIoAsJson");
      expect(url).toMatch(/limit=1000/);
      const headers = new Headers(init?.headers);
      const auth = headers.get("authorization") ?? "";
      expect(auth.startsWith("Basic ")).toBe(true);
      const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
      expect(decoded).toBe("pk-lf-test:sk-lf-test");
    }

    // Cursor query param threaded correctly across list pages.
    expect(listCalls[1]!.url).toContain("cursor=cursor-1");
    expect(listCalls[2]!.url).toContain("cursor=cursor-2");
  });

  it("fails on 401/403 with a credential hint and never reveals keys", async () => {
    const { mock } = captureFetch([{ status: 401, body: { error: "invalid key" } }]);

    let message: string | null = null;
    try {
      await fetchLangfuseTrace(TRACE_ID, basicConfig());
    } catch (err) {
      message = (err as Error).message;
    }
    expect(mock).toHaveBeenCalledTimes(1);
    expect(message).toMatch(/langfuse.*(auth|unauthor|reject)|unauthor/i);
    expect(message).not.toContain("sk-lf-test");
    expect(message).not.toContain("pk-lf-test");
  });

  it("fails on 404 / empty data with the requested trace id", async () => {
    captureFetch([{ status: 404, body: { error: "not found" } }]);
    await expect(fetchLangfuseTrace(TRACE_ID, basicConfig())).rejects.toThrow(
      new RegExp(TRACE_ID),
    );

    captureFetch([{ body: page([], { cursor: null }) }]);
    await expect(fetchLangfuseTrace(TRACE_ID, basicConfig())).rejects.toThrow(
      /empty|no observations/i,
    );
  });

  it("throws a LangfuseEmptyTraceError (distinguishable) when the page is empty", async () => {
    captureFetch([{ body: page([], { cursor: null }) }]);
    await expect(fetchLangfuseTrace(TRACE_ID, basicConfig())).rejects.toBeInstanceOf(
      LangfuseEmptyTraceError,
    );
  });

  it("rejects rows whose traceId differs from the requested source trace", async () => {
    captureFetch([
      { body: page([obsRow({ id: "a" }), obsRow({ id: "b", traceId: "other" })], { cursor: null }) },
    ]);
    await expect(fetchLangfuseTrace(TRACE_ID, basicConfig())).rejects.toThrow(/traceId/i);
  });

  it("enforces the observation safety ceiling before any partial write", async () => {
    // Build pages that exceed the ceiling by 1.
    const limit = 3;
    const rows: unknown[] = [];
    for (let i = 0; i < limit + 1; i++) {
      rows.push(obsRow({ id: `obs-${i}` }));
    }
    // Page size 1000 means we get all rows in one page; ceiling is hit at
    // client side.
    captureFetch([{ body: page(rows, { cursor: null }) }]);

    await expect(
      fetchLangfuseTrace(TRACE_ID, basicConfig({ maxObservations: limit })),
    ).rejects.toThrow(/max-observations|ceiling|safety/i);
  });

  it("attaches a 15s AbortSignal to every list page request", async () => {
    const { listCalls, detailCalls } = captureFetch(
      [{ body: page([obsRow({ id: "obs-1" })], { cursor: null }) }],
      { "obs-1": detailBody({ id: "obs-1" }) },
    );

    await fetchLangfuseTrace(TRACE_ID, basicConfig());

    expect(listCalls).toHaveLength(1);
    const init = listCalls[0]!.init as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // The signal must not already be aborted (the timer is what aborts it).
    expect((init.signal as AbortSignal).aborted).toBe(false);

    // Detail requests are also time-bounded with an AbortSignal.
    expect(detailCalls).toHaveLength(1);
    const detailInit = detailCalls[0]!.init as RequestInit;
    expect(detailInit.signal).toBeInstanceOf(AbortSignal);
    expect((detailInit.signal as AbortSignal).aborted).toBe(false);
  });
});

describe("fetchLangfuseTrace detail hydration (issue #25)", () => {
  // Regression: the v2 LIST endpoint stopped returning content-bearing fields
  // (name/input/output/metadata/model). Those fields ONLY live on the per-id
  // detail endpoint GET /api/public/observations/{id}. If hydration is skipped,
  // every imported trace arrives empty — generations show no prompt/completion/
  // reasoning, tools show no args/result, model is blank.
  beforeEach(() => {
    withKeys();
  });

  it("hydrates name/input/output/metadata/model from the detail endpoint when the list omits them", async () => {
    // The list row has NO content fields — exactly the bug.
    const { listCalls, detailCalls } = captureFetch(
      [{ body: page([bareListRow({ id: "obs-1" })], { cursor: null }) }],
      { "obs-1": detailBody({ id: "obs-1" }) },
    );

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig());
    const obs = graph.observations[0]!;

    // Content all comes from the detail endpoint.
    expect(obs.name).toBe("agent-llm-call");
    expect(obs.input).toEqual({ messages: [{ role: "user", content: "hi" }] });
    expect(obs.output).toEqual({ messages: [{ role: "assistant", content: "hello" }] });
    expect(obs.metadata).toEqual({ request_id: "req-1" });
    expect(obs.providedModelName).toBe("claude-opus-4-6");

    // List is still used for discovery; detail is the per-id source of truth.
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]!.url).toContain("/api/public/v2/observations");
    expect(detailCalls).toHaveLength(1);
    expect(detailCalls[0]!.url).toContain("/api/public/observations/obs-1");
    expect(detailCalls[0]!.url).not.toContain("/v2/");
  });

  it("sends Basic auth + AbortSignal to every detail request", async () => {
    const { detailCalls } = captureFetch(
      [{ body: page([bareListRow({ id: "obs-1" })], { cursor: null }) }],
      { "obs-1": detailBody({ id: "obs-1" }) },
    );

    await fetchLangfuseTrace(TRACE_ID, basicConfig());

    expect(detailCalls).toHaveLength(1);
    const headers = new Headers(detailCalls[0]!.init?.headers);
    const auth = headers.get("authorization") ?? "";
    expect(auth.startsWith("Basic ")).toBe(true);
    const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
    expect(decoded).toBe("pk-lf-test:sk-lf-test");
    expect(detailCalls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("hydrates every observation across multiple list pages (bounded concurrency)", async () => {
    captureFetch(
      [
        { body: page([bareListRow({ id: "a" }), bareListRow({ id: "b" })], { cursor: "c1" }) },
        { body: page([bareListRow({ id: "c" })], { cursor: null }) },
      ],
      {
        a: detailBody({ id: "a", name: "gen-a", model: "model-a" }),
        b: detailBody({ id: "b", name: "tool-b", type: "TOOL", model: "model-b" }),
        c: detailBody({ id: "c", name: "span-c", type: "SPAN", model: "model-c" }),
      },
    );

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig());

    expect(graph.observations.map((o) => o.id)).toEqual(["a", "b", "c"]);
    expect(graph.observations.map((o) => o.name)).toEqual(["gen-a", "tool-b", "span-c"]);
    expect(graph.observations.map((o) => o.providedModelName)).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("treats the detail endpoint as authoritative — detail content overrides any stale list content", async () => {
    // Defensive: even if the list returns SOME content, the detail wins so we
    // never serve stale/partial content to the converter.
    captureFetch(
      [
        {
          body: page(
            [
              {
                ...bareListRow({ id: "obs-1" }),
                name: "STALE-FROM-LIST",
                model: "stale-model",
              },
            ],
            { cursor: null },
          ),
        },
      ],
      { "obs-1": detailBody({ id: "obs-1", name: "agent-llm-call", model: "claude-opus-4-6" }) },
    );

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig());
    const obs = graph.observations[0]!;

    expect(obs.name).toBe("agent-llm-call");
    expect(obs.providedModelName).toBe("claude-opus-4-6");
  });

  it("preserves structural fields (parent/timing/usage) on the merged observation", async () => {
    captureFetch(
      [
        {
          body: page(
            [
              {
                ...bareListRow({ id: "root" }),
                parentObservationId: null,
                usageDetails: { input: 7, output: 3 },
                totalCost: 0.5,
              },
              {
                ...bareListRow({ id: "child" }),
                parentObservationId: "root",
              },
            ],
            { cursor: null },
          ),
        },
      ],
      {
        // Detail is a superset: it carries the same structural fields as the
        // list, plus content. The merge must keep them, not drop them.
        root: detailBody({ id: "root", name: "root-gen", parentObservationId: null, usageDetails: { input: 7, output: 3 } }),
        child: detailBody({ id: "child", name: "child-tool", type: "TOOL", parentObservationId: "root" }),
      },
    );

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig());
    const byId = new Map(graph.observations.map((o) => [o.id, o]));

    expect(byId.get("child")!.parentObservationId).toBe("root");
    expect(byId.get("root")!.usageDetails).toEqual({ input: 7, output: 3 });
  });

  it("throws (never silently drops content) when a detail request fails", async () => {
    captureFetch(
      [{ body: page([bareListRow({ id: "obs-1" })], { cursor: null }) }],
      // No detail mock -> captureFetch throws a clear error for the detail call.
    );

    await expect(fetchLangfuseTrace(TRACE_ID, basicConfig())).rejects.toThrow(/obs-1|detail/i);
  });
});

describe("pollLangfuseTrace", () => {
  beforeEach(() => {
    withKeys();
  });

  it("waits for existence then stability before fetching (issue #39)", async () => {
    // The trace appears with 1 observation, then a second arrives. The poll
    // must wait for the count to stabilize, not return on the first observation.
    const { listCalls, detailCalls } = captureFetch(
      [
        { body: page([], { cursor: null }) },
        { body: page([], { cursor: null }) },
        { body: page([obsRow({ id: "a" })], { cursor: null }) },
        { body: page([obsRow({ id: "a" }), obsRow({ id: "b" })], { cursor: null }) },
        { body: page([obsRow({ id: "a" }), obsRow({ id: "b" })], { cursor: null }) },
        { body: page([obsRow({ id: "a" }), obsRow({ id: "b" })], { cursor: null }) },
      ],
      { a: detailBody({ id: "a" }), b: detailBody({ id: "b" }) },
    );
    const sleeps: number[] = [];

    const result = await pollLangfuseTrace(TRACE_ID, basicConfig(), {
      totalDeadlineMs: 120_000,
      initialIntervalMs: 2_000,
      maxIntervalMs: 15_000,
      backoffFactor: 1.5,
      now: () => 1_000_000,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    expect(result.graph.observations.map((o) => o.id)).toEqual(["a", "b"]);
    expect(result.notices).toEqual([]);
    // 6 count-only polls + 1 list in the final fetchLangfuseTrace.
    expect(listCalls).toHaveLength(7);
    // Details only fetched once, during the final fetchLangfuseTrace.
    expect(detailCalls).toHaveLength(2);
    // Existence phase uses backoff (2s, 3s), stability phase uses fixed 2s.
    // (Additional sleeps after this come from detail hydration throttling.)
    expect(sleeps.slice(0, 5)).toEqual([2_000, 3_000, 2_000, 2_000, 2_000]);
  });

  it("imports best-effort with a notice when the count never stabilizes before the deadline", async () => {
    // The trace keeps growing every poll; the deadline expires before stability.
    captureFetch(
      [
        { body: page([obsRow({ id: "a" })], { cursor: null }) },
        { body: page([obsRow({ id: "a" }), obsRow({ id: "b" })], { cursor: null }) },
        { body: page([obsRow({ id: "a" }), obsRow({ id: "b" }), obsRow({ id: "c" })], { cursor: null }) },
      ],
      { a: detailBody({ id: "a" }), b: detailBody({ id: "b" }), c: detailBody({ id: "c" }) },
    );
    let elapsed = 0;

    const result = await pollLangfuseTrace(TRACE_ID, basicConfig(), {
      totalDeadlineMs: 3_000,
      initialIntervalMs: 2_000,
      maxIntervalMs: 15_000,
      backoffFactor: 1.5,
      now: () => elapsed,
      sleep: async (ms) => { elapsed += ms; },
    });

    expect(result.graph.observations.map((o) => o.id)).toEqual(["a", "b", "c"]);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toMatch(/still growing/i);
    expect(result.notices[0]).toMatch(/re-run/i);
  });

  it("throws LangfuseEmptyTraceError once the deadline elapses with no observations", async () => {
    captureFetch([{ body: page([], { cursor: null }) }]);
    let elapsed = 0;
    let caught: unknown;
    try {
      await pollLangfuseTrace(TRACE_ID, basicConfig(), {
        totalDeadlineMs: 3_500,
        initialIntervalMs: 1_000,
        maxIntervalMs: 5_000,
        backoffFactor: 2,
        now: () => elapsed,
        sleep: async (ms) => { elapsed += ms; },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LangfuseEmptyTraceError);
    expect((caught as Error).message).toMatch(/after waiting \d+s across \d+ attempt/i);
  });

  it("propagates hard errors (401) immediately without retrying", async () => {
    const { mock } = captureFetch([{ status: 401, body: {} }]);

    await expect(
      pollLangfuseTrace(TRACE_ID, basicConfig(), {
        totalDeadlineMs: 60_000,
        initialIntervalMs: 1_000,
        maxIntervalMs: 5_000,
        backoffFactor: 2,
        now: () => 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/auth/i);

    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("does not hydrate details during polling — only counts list rows", async () => {
    // Details are expensive (per-observation GETs). The poll loop must only
    // paginate the LIST to count, never hydrate, until stability is confirmed.
    const { detailCalls } = captureFetch(
      [
        { body: page([], { cursor: null }) },
        { body: page([obsRow({ id: "a" })], { cursor: null }) },
        { body: page([obsRow({ id: "a" })], { cursor: null }) },
        { body: page([obsRow({ id: "a" })], { cursor: null }) },
      ],
      { a: detailBody({ id: "a" }) },
    );

    const result = await pollLangfuseTrace(TRACE_ID, basicConfig(), {
      totalDeadlineMs: 60_000,
      initialIntervalMs: 2_000,
      maxIntervalMs: 15_000,
      backoffFactor: 1.5,
      now: () => 1_000_000,
      sleep: async () => {},
    });

    expect(detailCalls).toHaveLength(1);
    expect(result.graph.observations.map((o) => o.id)).toEqual(["a"]);
  });

  it("clamps existence-phase backoff to maxIntervalMs and remaining time", async () => {
    captureFetch([{ body: page([], { cursor: null }) }]);
    const sleeps: number[] = [];
    let elapsed = 0;

    await expect(
      pollLangfuseTrace(TRACE_ID, basicConfig(), {
        totalDeadlineMs: 500,
        initialIntervalMs: 10_000,
        maxIntervalMs: 8_000,
        backoffFactor: 2,
        now: () => elapsed,
        sleep: async (ms) => { sleeps.push(ms); elapsed += ms; },
      }),
    ).rejects.toBeInstanceOf(LangfuseEmptyTraceError);

    // remaining (500) is smaller than maxIntervalMs (8000) and interval (10000).
    expect(sleeps).toEqual([500]);
  });
});

describe("fetchLangfuseTrace I/O coercion (parseIoAsJson removed)", () => {
  // Content now arrives via the per-id DETAIL endpoint. Both the detail payload
  // and (legacy) list rows may carry input/output/metadata either as raw JSON
  // strings (Langfuse Cloud) or as already-parsed objects (self-hosted builds).
  // The connector parses them client-side so the downstream converter receives
  // structured JsonValue objects.
  beforeEach(() => {
    withKeys();
  });

  function ioDetail(over: Record<string, unknown> = {}): unknown {
    // Respect explicit values (including null) via key-presence checks.
    // Using `??` would drop an intentional null input back to the default.
    const pick = (key: string, fallback: unknown): unknown =>
      key in over ? over[key] : fallback;
    return detailBody({
      id: pick("id", "obs-1"),
      input: pick("input", JSON.stringify({ messages: [{ role: "user", content: "hi" }] })),
      output: pick("output", JSON.stringify({ messages: [{ role: "assistant", content: "hello" }] })),
      metadata: pick("metadata", JSON.stringify({ request_id: "req-1" })),
    });
  }

  it("parses raw JSON-string input/output/metadata into structured values", async () => {
    captureFetch(
      [{ body: page([bareListRow({ id: "obs-1" })], { cursor: null }) }],
      { "obs-1": ioDetail() },
    );

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig());
    const obs = graph.observations[0]!;

    expect(obs.input).toEqual({ messages: [{ role: "user", content: "hi" }] });
    expect(obs.output).toEqual({ messages: [{ role: "assistant", content: "hello" }] });
    expect(obs.metadata).toEqual({ request_id: "req-1" });
  });

  it("parses arrays and primitives encoded as JSON strings", async () => {
    captureFetch(
      [{ body: page([bareListRow({ id: "arr" })], { cursor: null }) }],
      {
        "arr": ioDetail({
          id: "arr",
          input: JSON.stringify([1, "two", { nested: true }]),
          output: JSON.stringify(42),
          metadata: JSON.stringify("plain-string-meta"),
        }),
      },
    );

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig());
    const obs = graph.observations[0]!;

    expect(obs.input).toEqual([1, "two", { nested: true }]);
    expect(obs.output).toBe(42);
    expect(obs.metadata).toBe("plain-string-meta");
  });

  it("preserves explicit JSON null input/output (not coerced to absent)", async () => {
    captureFetch(
      [{ body: page([bareListRow({ id: "n" })], { cursor: null }) }],
      { n: ioDetail({ id: "n", input: null, output: null }) },
    );

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig());
    const obs = graph.observations[0]!;

    expect(obs.input).toBeNull();
    expect(obs.output).toBeNull();
  });

  it("leaves absent I/O fields absent (undefined), distinct from null", async () => {
    captureFetch(
      [{ body: page([bareListRow({ id: "absent" })], { cursor: null }) }],
      {
        // A detail payload that simply omits input/output/metadata.
        absent: {
          id: "absent",
          traceId: TRACE_ID,
          type: "SPAN",
          startTime: "2026-07-22T10:00:00.000000Z",
          name: "bare-span",
        },
      },
    );

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig());
    const obs = graph.observations[0]!;

    expect(obs.input).toBeUndefined();
    expect(obs.output).toBeUndefined();
    expect(obs.metadata).toBeUndefined();
  });

  it("falls back to the raw string when input is not valid JSON (defensive, no crash)", async () => {
    captureFetch(
      [{ body: page([bareListRow({ id: "bad" })], { cursor: null }) }],
      { bad: ioDetail({ id: "bad", input: "not valid json {" }) },
    );

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig());
    const obs = graph.observations[0]!;

    expect(obs.input).toBe("not valid json {");
  });

  it("passes through already-structured I/O unchanged (self-hosted/older Langfuse)", async () => {
    const structured = { messages: [{ role: "user", content: "already object" }] };
    captureFetch(
      [{ body: page([bareListRow({ id: "obj" })], { cursor: null }) }],
      { obj: ioDetail({ id: "obj", input: structured, output: structured }) },
    );

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig());
    const obs = graph.observations[0]!;

    expect(obs.input).toEqual(structured);
    expect(obs.output).toEqual(structured);
  });
});

// ============================================================================
// Detail hydration rate-limit backoff (issue #28)
// ====================================================================
// The v2 LIST returns no content, so every observation costs one detail GET.
// On traces with many observations the burst trips Langfuse Cloud's project
// rate limit (429). Hydration must back off in-run (honoring Retry-After),
// retry the rate-limited observation in place, and preserve already-hydrated
// observations — NOT fail the whole import and restart from scratch.

type ScriptedResp = { status?: number; body?: unknown; headers?: Record<string, string> };

// Detail mock that pops scripted responses per observation id. Each id has a
// queue; the front is returned and the queue is drained. If the queue runs
// dry, the last response repeats (handy for "always 429").
function scriptedDetailFetch(
  listPages: ListPage[],
  scripts: Record<string, ScriptedResp[]>,
): { detailCalls: FetchCall[]; detailCallsById: Map<string, number>; mock: ReturnType<typeof vi.spyOn> } {
  const detailCalls: FetchCall[] = [];
  const detailCallsById = new Map<string, number>();
  const queues = new Map<string, ScriptedResp[]>();
  for (const [id, resps] of Object.entries(scripts)) queues.set(id, [...resps]);
  let listCallsCount = 0;
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const detailMatch = url.match(/\/api\/public\/observations\/([^/?]+)/);
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]!);
      detailCalls.push({ url, init });
      detailCallsById.set(id, (detailCallsById.get(id) ?? 0) + 1);
      const q = queues.get(id);
      const resp = q && q.length > 1 ? q.shift()! : q?.[0] ?? { status: 200, body: detailBody({ id }) };
      return new Response(JSON.stringify(resp.body ?? {}), {
        status: resp.status ?? 200,
        headers: { "Content-Type": "application/json", ...resp.headers },
      });
    }
    // List: drain from listPages (repeat last on overflow).
    const idx = Math.min(listCallsCount++, listPages.length - 1);
    const lp = listPages[idx] ?? listPages[listPages.length - 1];
    return new Response(JSON.stringify(lp.body ?? {}), {
      status: lp.status ?? 200,
      headers: { "Content-Type": "application/json", ...lp.headers },
    });
  });
  return { detailCalls, detailCallsById, mock };
}

describe("fetchLangfuseTrace detail hydration rate-limit backoff (issue #28)", () => {
  beforeEach(() => {
    withKeys();
  });

  it("retries the same observation after a 429 and completes the import", async () => {
    scriptedDetailFetch(
      [{ body: page([bareListRow({ id: "obs-1" })], { cursor: null }) }],
      {
        "obs-1": [
          { status: 429, body: {}, headers: { "Retry-After": "2" } },
          { status: 200, body: detailBody({ id: "obs-1" }) },
        ],
      },
    );
    const sleeps: number[] = [];

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig(), {
      now: () => 1_000_000,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    const obs = graph.observations[0]!;
    expect(obs.name).toBe("agent-llm-call");
    expect(obs.providedModelName).toBe("claude-opus-4-6");
    // The detail endpoint was hit twice: the 429 then the successful retry.
    expect(sleeps.some((s) => s === 2_000)).toBe(true);
  });

  it("honors a delta-seconds Retry-After header value", async () => {
    const { detailCallsById } = scriptedDetailFetch(
      [{ body: page([bareListRow({ id: "obs-1" })], { cursor: null }) }],
      {
        "obs-1": [
          { status: 429, body: {}, headers: { "Retry-After": "5" } },
          { status: 200, body: detailBody({ id: "obs-1" }) },
        ],
      },
    );
    const sleeps: number[] = [];

    await fetchLangfuseTrace(TRACE_ID, basicConfig(), {
      now: () => 2_000_000,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    expect(detailCallsById.get("obs-1")).toBe(2);
    // Retry-After: 5 (seconds) -> 5000ms backoff applied.
    expect(sleeps.some((s) => s === 5_000)).toBe(true);
  });

  it("honors an HTTP-date Retry-After header relative to now()", async () => {
    const fixedNow = Date.parse("2026-07-26T12:00:00Z");
    const future = new Date(fixedNow + 3_000).toUTCString();
    scriptedDetailFetch(
      [{ body: page([bareListRow({ id: "obs-1" })], { cursor: null }) }],
      {
        "obs-1": [
          { status: 429, body: {}, headers: { "Retry-After": future } },
          { status: 200, body: detailBody({ id: "obs-1" }) },
        ],
      },
    );
    const sleeps: number[] = [];

    await fetchLangfuseTrace(TRACE_ID, basicConfig(), {
      now: () => fixedNow,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    // HTTP-date 3s in the future -> ~3000ms wait.
    expect(sleeps.some((s) => s === 3_000)).toBe(true);
  });

  it("uses exponential backoff when Retry-After is absent", async () => {
    scriptedDetailFetch(
      [{ body: page([bareListRow({ id: "obs-1" })], { cursor: null }) }],
      {
        "obs-1": [
          { status: 429, body: {} },
          { status: 200, body: detailBody({ id: "obs-1" }) },
        ],
      },
    );
    const sleeps: number[] = [];

    await fetchLangfuseTrace(TRACE_ID, basicConfig(), {
      now: () => 1_000_000,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    // First backoff with no Retry-After is the base delay (1000ms).
    expect(sleeps.some((s) => s === 1_000)).toBe(true);
  });

  it("preserves already-hydrated observations when a later one is rate-limited", async () => {
    // Three observations; b is rate-limited once then succeeds. a and c
    // hydrate on the first attempt. None of the three may be lost.
    const { detailCallsById } = scriptedDetailFetch(
      [{ body: page([bareListRow({ id: "a" }), bareListRow({ id: "b" }), bareListRow({ id: "c" })], { cursor: null }) }],
      {
        a: [{ status: 200, body: detailBody({ id: "a", name: "gen-a", model: "model-a" }) }],
        b: [
          { status: 429, body: {}, headers: { "Retry-After": "1" } },
          { status: 200, body: detailBody({ id: "b", name: "tool-b", type: "TOOL", model: "model-b" }) },
        ],
        c: [{ status: 200, body: detailBody({ id: "c", name: "span-c", type: "SPAN", model: "model-c" }) }],
      },
    );

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig(), {
      now: () => 1_000_000,
      sleep: async () => {},
    });

    expect(graph.observations.map((o) => o.id)).toEqual(["a", "b", "c"]);
    expect(graph.observations.map((o) => o.name)).toEqual(["gen-a", "tool-b", "span-c"]);
    expect(graph.observations.map((o) => o.providedModelName)).toEqual(["model-a", "model-b", "model-c"]);
    // b was retried after the 429; a and c were fetched exactly once.
    expect(detailCallsById.get("a")).toBe(1);
    expect(detailCallsById.get("b")).toBe(2);
    expect(detailCallsById.get("c")).toBe(1);
  });

  it("fails with a clear error after exhausting retries on a persistently rate-limited observation", async () => {
    scriptedDetailFetch(
      [{ body: page([bareListRow({ id: "obs-1" })], { cursor: null }) }],
      { "obs-1": [{ status: 429, body: {} }] },
    );

    await expect(
      fetchLangfuseTrace(TRACE_ID, basicConfig(), {
        now: () => 1_000_000,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/after \d+ attempts.*safe to retry/i);
  });

  it("makes exactly DETAIL_MAX_RETRIES + 1 attempts before giving up", async () => {
    const { detailCalls } = scriptedDetailFetch(
      [{ body: page([bareListRow({ id: "obs-1" })], { cursor: null }) }],
      { "obs-1": [{ status: 429, body: {} }] },
    );

    await expect(
      fetchLangfuseTrace(TRACE_ID, basicConfig(), {
        now: () => 1_000_000,
        sleep: async () => {},
      }),
    ).rejects.toThrow();

    expect(detailCalls).toHaveLength(DETAIL_MAX_RETRIES + 1);
  });

  it("still fails immediately on non-rate-limit detail errors (does not retry 404)", async () => {
    const { detailCalls } = scriptedDetailFetch(
      [{ body: page([bareListRow({ id: "obs-1" })], { cursor: null }) }],
      { "obs-1": [{ status: 404, body: {} }] },
    );

    await expect(
      fetchLangfuseTrace(TRACE_ID, basicConfig(), {
        now: () => 1_000_000,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/404|deleted/i);

    // 404 is not retryable; exactly one attempt.
    expect(detailCalls).toHaveLength(1);
  });

  it("throttles detail requests globally (observable inter-request spacing)", async () => {
    // Five observations hydrate cleanly on the first call each. With a global
    // throttle, workers must space their requests rather than burst all five
    // simultaneously — observable as non-zero sleeps in the injected clock.
    scriptedDetailFetch(
      [{ body: page([
        bareListRow({ id: "a" }), bareListRow({ id: "b" }), bareListRow({ id: "c" }),
        bareListRow({ id: "d" }), bareListRow({ id: "e" }),
      ], { cursor: null }) }],
      {
        a: [{ status: 200, body: detailBody({ id: "a" }) }],
        b: [{ status: 200, body: detailBody({ id: "b" }) }],
        c: [{ status: 200, body: detailBody({ id: "c" }) }],
        d: [{ status: 200, body: detailBody({ id: "d" }) }],
        e: [{ status: 200, body: detailBody({ id: "e" }) }],
      },
    );
    const sleeps: number[] = [];

    await fetchLangfuseTrace(TRACE_ID, basicConfig(), {
      now: () => 5_000_000,
      sleep: async (ms) => { if (ms > 0) sleeps.push(ms); },
    });

    // More than one observation means at least one throttle wait occurred.
    expect(sleeps.length).toBeGreaterThan(0);
  });
});
