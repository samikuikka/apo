import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SOURCE_TRACE_ID = "8f38c27a2c4b4bafb87a78e3a3d62b90";
const MAPPED_TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

type FetchCall = { url: string; init?: RequestInit };

type Resp = { status?: number; body?: unknown; headers?: Record<string, string> };

// URL-routed fetch mock. Hydration inserts per-id DETAIL calls between the
// Langfuse LIST pages and the apo writes, so routing by URL (rather than call
// order) keeps every endpoint's responses independent.
function captureFetch(opts: {
  listPages?: Resp[];
  details?: Record<string, unknown>;
  otlp?: Resp;
  visibility?: Resp[];
}): { calls: FetchCall[]; mock: ReturnType<typeof vi.spyOn> } {
  const calls: FetchCall[] = [];
  const listQueue = [...(opts.listPages ?? [])];
  const visQueue = [...(opts.visibility ?? [])];
  let lastList: Resp | undefined;
  let lastVis: Resp | undefined;
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init: init as RequestInit | undefined });

    // Langfuse DETAIL: /api/public/observations/{id} (no /v2/).
    const detailMatch = url.match(/\/api\/public\/observations\/([^/?]+)/);
    if (detailMatch && !url.includes("/v2/")) {
      const id = decodeURIComponent(detailMatch[1]!);
      const body = opts.details?.[id] ?? detailRow({ id });
      return jsonResp(body);
    }
    // Langfuse LIST (repeats last page on overflow, e.g. --wait polling).
    if (url.includes("/api/public/v2/observations")) {
      const next = listQueue.shift();
      if (next) lastList = next;
      const resp = lastList ?? { status: 404, body: { detail: "not found" } };
      return jsonResp(resp.body, resp.status, resp.headers);
    }
    // apo OTLP POST.
    if (url.includes("/api/public/otel/v1/traces")) {
      const o = opts.otlp ?? { status: 200, body: {} };
      return jsonResp(o.body, o.status, o.headers);
    }
    // apo visibility poll on /v1/runs/{mappedTraceId} (repeats last response).
    if (url.includes("/v1/runs/")) {
      const next = visQueue.shift();
      if (next) lastVis = next;
      const resp = lastVis ?? { status: 404, body: { detail: "not found" } };
      return jsonResp(resp.body, resp.status, resp.headers);
    }
    return jsonResp({}, 404);
  });
  return { calls, mock };
}

function jsonResp(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body ?? {}), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function langfusePage(rows: unknown[], cursor: string | null = null): unknown {
  return { data: rows, meta: { cursor } };
}

// A bare LIST row: the v2 list endpoint returns only summary fields. Content
// (name/input/output/model) arrives via the detail endpoint instead (issue #25).
function basicRow(over: Partial<Record<string, unknown>> = {}): unknown {
  return {
    id: over.id ?? "obs-1",
    traceId: over.traceId ?? SOURCE_TRACE_ID,
    type: over.type ?? "SPAN",
    startTime: over.startTime ?? "2026-07-22T10:00:00.000000Z",
    endTime: over.endTime ?? "2026-07-22T10:00:01.000000Z",
  };
}

// Full DETAIL payload for one observation.
function detailRow(over: Partial<Record<string, unknown>> = {}): unknown {
  return {
    id: over.id ?? "obs-1",
    traceId: over.traceId ?? SOURCE_TRACE_ID,
    type: over.type ?? "SPAN",
    startTime: over.startTime ?? "2026-07-22T10:00:00.000000Z",
    endTime: over.endTime ?? "2026-07-22T10:00:01.000000Z",
    name: over.name ?? "agent-llm-call",
    model: over.model ?? "claude-opus-4-6",
    input: over.input ?? JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    output: over.output ?? JSON.stringify({ messages: [{ role: "assistant", content: "hello" }] }),
  };
}

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  return { lines, restore: () => { console.log = orig; } };
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  return { lines, restore: () => { console.error = orig; } };
}

beforeEach(() => {
  vi.stubEnv("LANGFUSE_HOST", "");
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
  vi.stubEnv("APO_API_KEY", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("apo traces import langfuse — happy path (scene 1)", () => {
  it("fetches every page with Basic auth and submits to apo with Bearer auth, exits 0", async () => {
    const { run } = await import("../src/commands/traces-import-langfuse.ts");
    const { calls } = captureFetch({
      listPages: [
        { body: langfusePage([basicRow({ id: "a" }), basicRow({ id: "b" })], "cursor-2") },
        { body: langfusePage([basicRow({ id: "c" })], null) },
      ],
      details: {
        a: detailRow({ id: "a" }),
        b: detailRow({ id: "b" }),
        c: detailRow({ id: "c" }),
      },
      otlp: {
        status: 200,
        body: {},
        headers: {
          "X-Otlp-Accepted": "3",
          "X-Otlp-Rejected": "0",
          "X-Otlp-Batch-Id": "batch-1",
        },
      },
      visibility: [
        { status: 404, body: { detail: "not found" } },
        { status: 200, body: { run: { id: "trace-1" }, calls: [], metrics: [] } },
      ],
    });

    const out = captureStdout();
    const code = await run([
      SOURCE_TRACE_ID,
      "--backend",
      "http://apo.test",
      "--api-key",
      "apo-key-test",
      "--project",
      "proj-1",
    ]);
    out.restore();

    expect(code).toBe(0);
    expect(calls.length).toBeGreaterThanOrEqual(4);

    // Langfuse calls carry Basic auth, the right traceId, and field list.
    // parseIoAsJson must not be sent (Langfuse Cloud removed it; 400s now).
    const lfCalls = calls.filter((c) => c.url.includes("/api/public/v2/observations"));
    expect(lfCalls).toHaveLength(2);
    for (const c of lfCalls) {
      const headers = new Headers(c.init?.headers);
      expect(headers.get("authorization")).toMatch(/^Basic /);
      expect(c.url).toContain(`traceId=${SOURCE_TRACE_ID}`);
      expect(c.url).not.toContain("parseIoAsJson");
      expect(c.url).toContain("fields=");
    }

    // apo OTLP POST carries Bearer auth and the project api key.
    const otlpCall = calls.find((c) => c.url.includes("/api/public/otel/v1/traces"));
    expect(otlpCall).toBeDefined();
    const otlpHeaders = new Headers(otlpCall!.init?.headers);
    expect(otlpHeaders.get("authorization")).toBe("Bearer apo-key-test");
    expect(otlpHeaders.get("content-type")).toBe("application/json");

    // Visibility poll on /v1/runs/{mappedTraceId}.
    const visibilityCalls = calls.filter((c) => c.url.includes("/v1/runs/"));
    expect(visibilityCalls.length).toBeGreaterThanOrEqual(2);
    expect(visibilityCalls[0]!.url).toContain("project=proj-1");

    // Human-readable output includes the inspect hint with a 32-hex mapped id.
    const stdout = out.lines.join("\n");
    expect(stdout).toMatch(/[0-9a-f]{32}/);
    expect(stdout).toContain("apo traces show ");
    expect(stdout).toContain(SOURCE_TRACE_ID);
  });

  it("machine-readable --json output matches LangfuseImportResult", async () => {
    const { run } = await import("../src/commands/traces-import-langfuse.ts");
    captureFetch({
      listPages: [{ body: langfusePage([basicRow()], null) }],
      details: { "obs-1": detailRow({ id: "obs-1" }) },
      otlp: {
        status: 200,
        body: {},
        headers: { "X-Otlp-Accepted": "1", "X-Otlp-Rejected": "0", "X-Otlp-Batch-Id": "batch-1" },
      },
      visibility: [{ status: 200, body: { run: { id: "trace-1" }, calls: [], metrics: [] } }],
    });

    const out = captureStdout();
    const code = await run([
      SOURCE_TRACE_ID,
      "--backend",
      "http://apo.test",
      "--api-key",
      "apo-key-test",
      "--json",
    ]);
    out.restore();

    expect(code).toBe(0);
    const parsed = JSON.parse(out.lines.join("\n"));
    expect(parsed.source).toBe("langfuse");
    expect(parsed.sourceHost).toBe("https://cloud.langfuse.com");
    expect(parsed.sourceTraceId).toBe(SOURCE_TRACE_ID);
    expect(parsed.traceId).toMatch(MAPPED_TRACE_ID_PATTERN);
    expect(parsed.observationsFetched).toBe(1);
    expect(parsed.spansSubmitted).toBe(1);
    expect(parsed.spansAccepted).toBe(1);
    expect(parsed.spansRejected).toBe(0);
    expect(parsed.otlpBatchIds).toEqual(["batch-1"]);
    expect(parsed.projected).toBe(true);
    expect(parsed.notices).toEqual([]);
  });
});

describe("apo traces import langfuse — --trace-id target (issue #36)", () => {
  it("emits spans under the caller-supplied trace id (merge into a run trace)", async () => {
    const { run } = await import("../src/commands/traces-import-langfuse.ts");
    const TARGET = "ba304669483e53622109e9a6c8905143";
    const { calls } = captureFetch({
      listPages: [{ body: langfusePage([basicRow()], null) }],
      details: { "obs-1": detailRow({ id: "obs-1" }) },
      otlp: {
        status: 200,
        body: {},
        headers: { "X-Otlp-Accepted": "1", "X-Otlp-Rejected": "0", "X-Otlp-Batch-Id": "batch-1" },
      },
      visibility: [{ status: 200, body: { run: { id: "trace-1" }, calls: [], metrics: [] } }],
    });

    const out = captureStdout();
    const code = await run([
      SOURCE_TRACE_ID,
      "--backend",
      "http://apo.test",
      "--api-key",
      "apo-key-test",
      "--trace-id",
      TARGET,
      "--json",
    ]);
    out.restore();

    expect(code).toBe(0);
    const parsed = JSON.parse(out.lines.join("\n"));
    expect(parsed.traceId).toBe(TARGET);

    // The OTLP POST body carries the target trace id on every span.
    const otlpCall = calls.find((c) => c.url.includes("/api/public/otel/v1/traces"));
    expect(otlpCall).toBeDefined();
    const body = JSON.parse((otlpCall!.init as RequestInit).body as string);
    const spans = body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans ?? [];
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.traceId).toBe(TARGET);
    }
  });

  it("exits 2 before any network I/O when --trace-id is not a valid W3C trace id", async () => {
    const { run } = await import("../src/commands/traces-import-langfuse.ts");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const err = captureStderr();
    const code = await run([
      SOURCE_TRACE_ID,
      "--backend",
      "http://apo.test",
      "--api-key",
      "apo-key-test",
      "--trace-id",
      "not-a-valid-trace-id",
    ]);
    err.restore();

    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(err.lines.join("\n")).toMatch(/--trace-id|trace.?id/i);
  });

  it("exits 2 when --trace-id is given without a value", async () => {
    const { run } = await import("../src/commands/traces-import-langfuse.ts");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const err = captureStderr();
    const code = await run([
      SOURCE_TRACE_ID,
      "--backend",
      "http://apo.test",
      "--api-key",
      "apo-key-test",
      "--trace-id",
    ]);
    err.restore();

    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(err.lines.join("\n")).toMatch(/--trace-id/i);
  });
});

describe("apo traces import langfuse — partial rejection (scene 3)", () => {
  it("exits 2 and prints accepted/rejected counts + batch id; never claims success", async () => {
    const { run } = await import("../src/commands/traces-import-langfuse.ts");
    captureFetch({
      listPages: [{ body: langfusePage([basicRow(), basicRow({ id: "b" })], null) }],
      details: { "obs-1": detailRow({ id: "obs-1" }), b: detailRow({ id: "b" }) },
      otlp: {
        status: 200,
        body: { partialSuccess: { errorMessage: "one bad span" } },
        headers: { "X-Otlp-Accepted": "1", "X-Otlp-Rejected": "1", "X-Otlp-Batch-Id": "batch-2" },
      },
    });

    const out = captureStdout();
    const err = captureStderr();
    const code = await run([
      SOURCE_TRACE_ID,
      "--backend",
      "http://apo.test",
      "--api-key",
      "apo-key-test",
    ]);
    out.restore();
    err.restore();

    expect(code).toBe(2);
    const combined = [...out.lines, ...err.lines].join("\n");
    expect(combined).toMatch(/accept/i);
    expect(combined).toMatch(/reject/i);
    expect(combined).toContain("batch-2");
    // Never claims the import was complete.
    expect(combined.toLowerCase()).not.toMatch(/imported.*success|import complete/i);
  });
});

describe("apo traces import langfuse — projection timeout (scene 4)", () => {
  it("exits 2 when the trace never becomes visible within the deadline", async () => {
    const { run } = await import("../src/commands/traces-import-langfuse.ts");
    captureFetch({
      listPages: [{ body: langfusePage([basicRow()], null) }],
      details: { "obs-1": detailRow({ id: "obs-1" }) },
      otlp: {
        status: 200,
        body: {},
        headers: { "X-Otlp-Accepted": "1", "X-Otlp-Rejected": "0", "X-Otlp-Batch-Id": "batch-3" },
      },
      // Subsequent visibility polls all 404 (last response repeats).
      visibility: [{ status: 404, body: { detail: "not found" } }],
    });

    const err = captureStderr();
    const code = await run(
      [
        SOURCE_TRACE_ID,
        "--backend",
        "http://apo.test",
        "--api-key",
        "apo-key-test",
      ],
    );
    err.restore();

    expect(code).toBe(2);
    const combined = err.lines.join("\n");
    expect(combined).toContain(SOURCE_TRACE_ID);
    // Should mention a mapped trace id and the batch id so the operator can
    // diagnose the durable ingestion queue.
    expect(combined).toMatch(/[0-9a-f]{32}/);
    expect(combined).toContain("batch-3");
  }, 20_000);
});

describe("apo traces import langfuse — config + arg errors", () => {
  it("exits 2 with actionable error when Langfuse creds are missing", async () => {
    const { run } = await import("../src/commands/traces-import-langfuse.ts");
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");

    const fetchMock = vi.spyOn(globalThis, "fetch");

    const err = captureStderr();
    const code = await run([
      SOURCE_TRACE_ID,
      "--backend",
      "http://apo.test",
      "--api-key",
      "apo-key-test",
    ]);
    err.restore();

    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(err.lines.join("\n")).toMatch(/LANGFUSE_PUBLIC_KEY/i);
  });

  it("exits 2 with missing-trace-id error when no positional is given", async () => {
    const { run } = await import("../src/commands/traces-import-langfuse.ts");
    const err = captureStderr();
    const code = await run([
      "--backend",
      "http://apo.test",
      "--api-key",
      "apo-key-test",
    ]);
    err.restore();

    expect(code).toBe(2);
    expect(err.lines.join("\n")).toMatch(/trace-id|missing/i);
  });
});

describe("apo traces import langfuse — source not yet available (empty)", () => {
  it("exits 75 (retryable) with an actionable hint when Langfuse has no observations yet, without polling", async () => {
    const { run } = await import("../src/commands/traces-import-langfuse.ts");
    const { calls } = captureFetch({
      listPages: [{ body: langfusePage([], null) }],
    });

    const err = captureStderr();
    const code = await run([
      SOURCE_TRACE_ID,
      "--backend",
      "http://apo.test",
      "--api-key",
      "apo-key-test",
    ]);
    err.restore();

    expect(code).toBe(75);
    const combined = err.lines.join("\n");
    expect(combined).toContain(SOURCE_TRACE_ID);
    expect(combined).toMatch(/no observations/i);
    expect(combined).toMatch(/--wait/i);
    expect(combined).toMatch(/retryable/i);
    // No --wait means exactly one source fetch and no apo write.
    const lfCalls = calls.filter((c) => c.url.includes("/api/public/v2/observations"));
    expect(lfCalls).toHaveLength(1);
    expect(calls.some((c) => c.url.includes("/api/public/otel/v1/traces"))).toBe(false);
  });
});

describe("apo traces import langfuse --wait source polling", () => {
  it("polls Langfuse until count stabilizes, then imports → exit 0", async () => {
    const { run } = await import("../src/commands/traces-import-langfuse.ts");
    const { calls } = captureFetch({
      listPages: [
        { body: langfusePage([], null) },
        { body: langfusePage([], null) },
        { body: langfusePage([basicRow({ id: "a" })], null) },
      ],
      details: { a: detailRow({ id: "a" }) },
      otlp: {
        status: 200,
        body: {},
        headers: { "X-Otlp-Accepted": "1", "X-Otlp-Rejected": "0", "X-Otlp-Batch-Id": "batch-1" },
      },
      visibility: [{ status: 200, body: { run: { id: "trace-1" }, calls: [], metrics: [] } }],
    });

    const out = captureStdout();
    const code = await run(
      [
        SOURCE_TRACE_ID,
        "--wait",
        "60",
        "--backend",
        "http://apo.test",
        "--api-key",
        "apo-key-test",
      ],
      { now: () => 1_000_000, sleep: async () => {} },
    );
    out.restore();

    expect(code).toBe(0);
    const lfCalls = calls.filter((c) => c.url.includes("/api/public/v2/observations"));
    // 2 empty polls + 3 stability polls (first sighting + 2 stable) + 1 final
    // fetchLangfuseTrace list = 6 total list calls (issue #39 stability fix).
    expect(lfCalls).toHaveLength(6);
    expect(out.lines.join("\n")).toContain(SOURCE_TRACE_ID);
  });

  it("exits 75 (retryable) when --wait deadline elapses with no observations", async () => {
    const { run } = await import("../src/commands/traces-import-langfuse.ts");
    const { calls } = captureFetch({
      listPages: [{ body: langfusePage([], null) }],
    });
    let first = true;
    const now = () => {
      if (first) { first = false; return 0; }
      return 10_000_000;
    };

    const err = captureStderr();
    const code = await run(
      [
        SOURCE_TRACE_ID,
        "--wait",
        "60",
        "--backend",
        "http://apo.test",
        "--api-key",
        "apo-key-test",
      ],
      { now, sleep: async () => {} },
    );
    err.restore();

    expect(code).toBe(75);
    const combined = err.lines.join("\n");
    expect(combined).toMatch(/after waiting/i);
    expect(combined).toMatch(/retryable/i);
    const lfCalls = calls.filter((c) => c.url.includes("/api/public/v2/observations"));
    expect(lfCalls.length).toBeGreaterThanOrEqual(1);
    // Never wrote to apo while waiting.
    expect(calls.some((c) => c.url.includes("/api/public/otel/v1/traces"))).toBe(false);
  });

  it("still exits 2 (hard error) on Langfuse 401 even with --wait", async () => {
    const { run } = await import("../src/commands/traces-import-langfuse.ts");
    captureFetch({ listPages: [{ status: 401, body: {} }] });

    const err = captureStderr();
    const code = await run(
      [
        SOURCE_TRACE_ID,
        "--wait",
        "60",
        "--backend",
        "http://apo.test",
        "--api-key",
        "apo-key-test",
      ],
      { now: () => 0, sleep: async () => {} },
    );
    err.restore();

    expect(code).toBe(2);
    expect(err.lines.join("\n")).toMatch(/auth/i);
  });
});

describe("apo traces import langfuse — --wait validation", () => {
  it("exits 2 when --wait is given without a value, before any network I/O", async () => {
    const { run } = await import("../src/commands/traces-import-langfuse.ts");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const err = captureStderr();
    const code = await run([
      SOURCE_TRACE_ID,
      "--wait",
      "--backend",
      "http://apo.test",
      "--api-key",
      "apo-key-test",
    ]);
    err.restore();

    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(err.lines.join("\n")).toMatch(/--wait/i);
  });

  it("exits 2 when --wait is non-numeric or negative, before any network I/O", async () => {
    const { run } = await import("../src/commands/traces-import-langfuse.ts");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    for (const bad of ["abc", "-5"]) {
      const err = captureStderr();
      const code = await run([
        SOURCE_TRACE_ID,
        "--wait",
        bad,
        "--backend",
        "http://apo.test",
        "--api-key",
        "apo-key-test",
      ]);
      err.restore();

      expect(code).toBe(2);
      expect(err.lines.join("\n")).toMatch(/--wait/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
