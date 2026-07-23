import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MAX_OBSERVATIONS,
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

function captureFetch(
  responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>,
): { calls: FetchCall[]; mock: ReturnType<typeof vi.spyOn> } {
  const calls: FetchCall[] = [];
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`fetch called more times than mocked; last url: ${url}`);
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json", ...next.headers },
    });
  });
  return { calls, mock };
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
    const { calls } = captureFetch([
      { body: page([obsRow({ id: "a" }), obsRow({ id: "b" })], { cursor: "cursor-1" }) },
      { body: page([obsRow({ id: "c" })], { cursor: "cursor-2" }) },
      { body: page([obsRow({ id: "d" })], { cursor: null }) },
    ]);

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig());

    expect(calls).toHaveLength(3);
    expect(graph.sourceHost).toBe(DEFAULT_HOST);
    expect(graph.sourceTraceId).toBe(TRACE_ID);
    expect(graph.observations.map((o) => o.id)).toEqual(["a", "b", "c", "d"]);

    // Every request carries the same traceId, full field list, and Basic auth.
    // parseIoAsJson must NOT be sent: Langfuse Cloud removed it from the v2
    // observations endpoint and now 400s on it. I/O is parsed client-side.
    for (const { url, init } of calls) {
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

    // Cursor query param threaded correctly.
    expect(calls[1]!.url).toContain("cursor=cursor-1");
    expect(calls[2]!.url).toContain("cursor=cursor-2");
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

  it("attaches a 15s AbortSignal to every page request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(page([obsRow()], { cursor: null })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await fetchLangfuseTrace(TRACE_ID, basicConfig());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // The signal must not already be aborted (the timer is what aborts it).
    expect((init.signal as AbortSignal).aborted).toBe(false);
  });
});

describe("pollLangfuseTrace", () => {
  beforeEach(() => {
    withKeys();
  });

  it("retries on empty with exponential backoff until observations appear", async () => {
    const { calls } = captureFetch([
      { body: page([], { cursor: null }) },
      { body: page([], { cursor: null }) },
      { body: page([obsRow({ id: "a" })], { cursor: null }) },
    ]);
    const sleeps: number[] = [];

    const graph = await pollLangfuseTrace(TRACE_ID, basicConfig(), {
      totalDeadlineMs: 60_000,
      initialIntervalMs: 2_000,
      maxIntervalMs: 15_000,
      backoffFactor: 1.5,
      now: () => 1_000_000,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    expect(graph.observations.map((o) => o.id)).toEqual(["a"]);
    expect(calls).toHaveLength(3);
    // Two backoffs before the successful third attempt: 2000 then 3000.
    expect(sleeps).toEqual([2_000, 3_000]);
  });

  it("throws LangfuseEmptyTraceError once the deadline elapses", async () => {
    captureFetch([{ body: page([], { cursor: null }) }]);
    let first = true;
    const now = () => {
      if (first) { first = false; return 0; }
      return 10_000_000;
    };

    let caught: unknown;
    try {
      await pollLangfuseTrace(TRACE_ID, basicConfig(), {
        totalDeadlineMs: 3_500,
        initialIntervalMs: 1_000,
        maxIntervalMs: 5_000,
        backoffFactor: 2,
        now,
        sleep: async () => {},
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

  it("clamps each backoff sleep to maxIntervalMs and the remaining time", async () => {
    captureFetch([
      { body: page([], { cursor: null }) },
      { body: page([obsRow()], { cursor: null }) },
    ]);
    const sleeps: number[] = [];

    await pollLangfuseTrace(TRACE_ID, basicConfig(), {
      totalDeadlineMs: 500,
      initialIntervalMs: 10_000,
      maxIntervalMs: 8_000,
      backoffFactor: 2,
      now: () => 0,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    // remaining (500) is smaller than maxIntervalMs (8000) and the raw
    // interval (10000), so the single sleep is clamped to 500.
    expect(sleeps).toEqual([500]);
  });
});

describe("fetchLangfuseTrace I/O coercion (parseIoAsJson removed)", () => {
  // Langfuse Cloud's v2 observations endpoint no longer supports
  // parseIoAsJson=true — input/output/metadata always come back as raw JSON
  // strings. The connector must parse them client-side so the downstream
  // converter still receives structured JsonValue objects.
  beforeEach(() => {
    withKeys();
  });

  function rowWithRawIo(over: Record<string, unknown> = {}): unknown {
    // Respect explicit values (including null) via key-presence checks.
    // Using `??` would drop an intentional null input back to the default.
    const pick = (key: string, fallback: unknown): unknown =>
      key in over ? over[key] : fallback;
    return {
      id: pick("id", "obs-1"),
      traceId: pick("traceId", TRACE_ID),
      type: pick("type", "GENERATION"),
      startTime: pick("startTime", "2026-07-22T10:00:00.000000Z"),
      input: pick("input", JSON.stringify({ messages: [{ role: "user", content: "hi" }] })),
      output: pick("output", JSON.stringify({ messages: [{ role: "assistant", content: "hello" }] })),
      metadata: pick("metadata", JSON.stringify({ request_id: "req-1" })),
    };
  }

  it("parses raw JSON-string input/output/metadata into structured values", async () => {
    captureFetch([{ body: page([rowWithRawIo()], { cursor: null }) }]);

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig());
    const obs = graph.observations[0]!;

    expect(obs.input).toEqual({ messages: [{ role: "user", content: "hi" }] });
    expect(obs.output).toEqual({ messages: [{ role: "assistant", content: "hello" }] });
    expect(obs.metadata).toEqual({ request_id: "req-1" });
  });

  it("parses arrays and primitives encoded as JSON strings", async () => {
    captureFetch([
      {
        body: page(
          [
            rowWithRawIo({
              id: "arr",
              input: JSON.stringify([1, "two", { nested: true }]),
              output: JSON.stringify(42),
              metadata: JSON.stringify("plain-string-meta"),
            }),
          ],
          { cursor: null },
        ),
      },
    ]);

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig());
    const obs = graph.observations[0]!;

    expect(obs.input).toEqual([1, "two", { nested: true }]);
    expect(obs.output).toBe(42);
    expect(obs.metadata).toBe("plain-string-meta");
  });

  it("preserves explicit JSON null input/output (not coerced to absent)", async () => {
    captureFetch([
      { body: page([rowWithRawIo({ id: "n", input: null, output: null })], { cursor: null }) },
    ]);

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig());
    const obs = graph.observations[0]!;

    expect(obs.input).toBeNull();
    expect(obs.output).toBeNull();
  });

  it("leaves absent I/O fields absent (undefined), distinct from null", async () => {
    captureFetch([
      {
        body: page(
          [
            {
              id: "absent",
              traceId: TRACE_ID,
              type: "SPAN",
              startTime: "2026-07-22T10:00:00.000000Z",
            },
          ],
          { cursor: null },
        ),
      },
    ]);

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig());
    const obs = graph.observations[0]!;

    expect(obs.input).toBeUndefined();
    expect(obs.output).toBeUndefined();
    expect(obs.metadata).toBeUndefined();
  });

  it("falls back to the raw string when input is not valid JSON (defensive, no crash)", async () => {
    captureFetch([
      {
        body: page(
          [rowWithRawIo({ id: "bad", input: "not valid json {" })],
          { cursor: null },
        ),
      },
    ]);

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig());
    const obs = graph.observations[0]!;

    expect(obs.input).toBe("not valid json {");
  });

  it("passes through already-structured I/O unchanged (self-hosted/older Langfuse)", async () => {
    const structured = { messages: [{ role: "user", content: "already object" }] };
    captureFetch([
      {
        body: page(
          [rowWithRawIo({ id: "obj", input: structured, output: structured })],
          { cursor: null },
        ),
      },
    ]);

    const graph = await fetchLangfuseTrace(TRACE_ID, basicConfig());
    const obs = graph.observations[0]!;

    expect(obs.input).toEqual(structured);
    expect(obs.output).toEqual(structured);
  });
});
