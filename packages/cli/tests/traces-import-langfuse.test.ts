import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SOURCE_TRACE_ID = "8f38c27a2c4b4bafb87a78e3a3d62b90";
const MAPPED_TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

type FetchCall = { url: string; init?: RequestInit };

function captureFetch(
  responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>,
): { calls: FetchCall[]; mock: ReturnType<typeof vi.spyOn> } {
  const calls: FetchCall[] = [];
  const responsesCopy = [...responses];
  let lastResponse: { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init: init as RequestInit | undefined });
    let next = responsesCopy.shift();
    if (next === undefined) {
      // Reuse the last response for any overflow (e.g. long polling).
      next = lastResponse ?? { status: 404, body: { detail: "not found" } };
    }
    lastResponse = next;
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json", ...next.headers },
    });
  });
  return { calls, mock };
}

function langfusePage(rows: unknown[], cursor: string | null = null): unknown {
  return { data: rows, meta: { cursor } };
}

function basicRow(over: Partial<Record<string, unknown>> = {}): unknown {
  return {
    id: over.id ?? "obs-1",
    traceId: over.traceId ?? SOURCE_TRACE_ID,
    type: over.type ?? "SPAN",
    startTime: over.startTime ?? "2026-07-22T10:00:00.000000Z",
    endTime: over.endTime ?? "2026-07-22T10:00:01.000000Z",
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
    const { calls } = captureFetch([
      // Langfuse page 1
      {
        body: langfusePage([basicRow({ id: "a" }), basicRow({ id: "b" })], "cursor-2"),
      },
      // Langfuse page 2
      {
        body: langfusePage([basicRow({ id: "c" })], null),
      },
      // apo OTLP POST
      {
        status: 200,
        body: {},
        headers: {
          "X-Otlp-Accepted": "3",
          "X-Otlp-Rejected": "0",
          "X-Otlp-Batch-Id": "batch-1",
        },
      },
      // apo visibility poll (first is 404)
      { status: 404, body: { detail: "not found" } },
      // apo visibility poll (200)
      { status: 200, body: { run: { id: "trace-1" }, calls: [], metrics: [] } },
    ]);

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
    const lfCalls = calls.filter((c) => c.url.includes("/api/public/v2/observations"));
    expect(lfCalls).toHaveLength(2);
    for (const c of lfCalls) {
      const headers = new Headers(c.init?.headers);
      expect(headers.get("authorization")).toMatch(/^Basic /);
      expect(c.url).toContain(`traceId=${SOURCE_TRACE_ID}`);
      expect(c.url).toContain("parseIoAsJson=true");
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
    captureFetch([
      { body: langfusePage([basicRow()], null) },
      {
        status: 200,
        body: {},
        headers: { "X-Otlp-Accepted": "1", "X-Otlp-Rejected": "0", "X-Otlp-Batch-Id": "batch-1" },
      },
      { status: 200, body: { run: { id: "trace-1" }, calls: [], metrics: [] } },
    ]);

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
  });
});

describe("apo traces import langfuse — partial rejection (scene 3)", () => {
  it("exits 2 and prints accepted/rejected counts + batch id; never claims success", async () => {
    const { run } = await import("../src/commands/traces-import-langfuse.ts");
    captureFetch([
      { body: langfusePage([basicRow(), basicRow({ id: "b" })], null) },
      {
        status: 200,
        body: { partialSuccess: { errorMessage: "one bad span" } },
        headers: { "X-Otlp-Accepted": "1", "X-Otlp-Rejected": "1", "X-Otlp-Batch-Id": "batch-2" },
      },
    ]);

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
    captureFetch([
      { body: langfusePage([basicRow()], null) },
      {
        status: 200,
        body: {},
        headers: { "X-Otlp-Accepted": "1", "X-Otlp-Rejected": "0", "X-Otlp-Batch-Id": "batch-3" },
      },
      // Subsequent visibility polls all 404 (mock repeats the last one).
      { status: 404, body: { detail: "not found" } },
    ]);

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
