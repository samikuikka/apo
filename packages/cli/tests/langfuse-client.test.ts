import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MAX_OBSERVATIONS,
  fetchLangfuseTrace,
  type LangfuseConnectorConfig,
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

    // Every request carries the same traceId, full field list, parseIoAsJson,
    // and Basic auth.
    for (const { url, init } of calls) {
      expect(url).toContain("/api/public/v2/observations");
      expect(url).toContain(`traceId=${TRACE_ID}`);
      expect(url).toContain("fields=");
      expect(url).toContain("parseIoAsJson=true");
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
