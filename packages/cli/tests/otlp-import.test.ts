import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildOtlpUrl,
  buildTraceDetailUrl,
  parseOtlpResponse,
  pollTraceVisibility,
  submitOtlpChunk,
  type ApoConfig,
  type ApoOtlpImportResponse,
} from "../src/lib/otlp-import.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const APO_CONFIG: ApoConfig = {
  backendUrl: "http://apo.test",
  apiKey: "apo-key-test",
  projectId: undefined,
};

describe("buildOtlpUrl", () => {
  it("joins the OTLP path onto a direct backend URL", () => {
    expect(buildOtlpUrl("http://apo.test")).toBe(
      "http://apo.test/api/public/otel/v1/traces",
    );
  });

  it("preserves a path prefix (proxy / same-origin)", () => {
    expect(buildOtlpUrl("https://apo.example.com/backend-proxy")).toBe(
      "https://apo.example.com/backend-proxy/api/public/otel/v1/traces",
    );
    expect(buildOtlpUrl("https://apo.example.com/backend-proxy/")).toBe(
      "https://apo.example.com/backend-proxy/api/public/otel/v1/traces",
    );
  });

  it("drops trailing slash and avoids double slashes", () => {
    expect(buildOtlpUrl("http://apo.test/")).toBe(
      "http://apo.test/api/public/otel/v1/traces",
    );
    expect(buildOtlpUrl("http://apo.test/backend/")).toBe(
      "http://apo.test/backend/api/public/otel/v1/traces",
    );
  });
});

describe("buildTraceDetailUrl", () => {
  it("builds /v1/runs/{traceId} with optional project query", () => {
    expect(buildTraceDetailUrl("http://apo.test", "abc123", undefined).toString()).toBe(
      "http://apo.test/v1/runs/abc123",
    );
    expect(
      buildTraceDetailUrl("http://apo.test", "abc123", "my-proj").toString(),
    ).toBe("http://apo.test/v1/runs/abc123?project=my-proj");
  });

  it("preserves a backend path prefix on the trace detail URL too", () => {
    expect(buildTraceDetailUrl("http://apo.test/proxy", "abc123", undefined).toString()).toBe(
      "http://apo.test/proxy/v1/runs/abc123",
    );
  });
});

describe("parseOtlpResponse", () => {
  it("reads accepted/rejected/batchId from response headers", async () => {
    const response = new Response("{}", {
      status: 200,
      headers: {
        "X-Otlp-Accepted": "42",
        "X-Otlp-Rejected": "3",
        "X-Otlp-Batch-Id": "batch-xyz",
      },
    });
    const parsed = await parseOtlpResponse(response);
    expect(parsed.acceptedSpans).toBe(42);
    expect(parsed.rejectedSpans).toBe(3);
    expect(parsed.batchId).toBe("batch-xyz");
  });

  it("treats missing headers as zero/empty rather than throwing", async () => {
    const response = new Response("{}", { status: 200 });
    const parsed = await parseOtlpResponse(response);
    expect(parsed.acceptedSpans).toBe(0);
    expect(parsed.rejectedSpans).toBe(0);
    expect(parsed.batchId).toBe("");
  });

  it("extracts partial-success error message when present", async () => {
    const response = new Response(
      JSON.stringify({ partialSuccess: { errorMessage: "one bad span" } }),
      {
        status: 200,
        headers: {
          "X-Otlp-Accepted": "1",
          "X-Otlp-Rejected": "1",
          "X-Otlp-Batch-Id": "b1",
        },
      },
    );
    const parsed = await parseOtlpResponse(response);
    expect(parsed.errorMessage).toBe("one bad span");
  });

  it("parses the body when it is a protobuf-style partial success shape", async () => {
    const response = new Response(JSON.stringify({ partialSuccess: { rejectedSpans: 2 } }), {
      status: 200,
      headers: { "X-Otlp-Batch-Id": "b2" },
    });
    const parsed = await parseOtlpResponse(response);
    expect(parsed.rejectedSpans).toBe(2);
  });
});

describe("submitOtlpChunk", () => {
  it("POSTs the JSON body with Bearer auth and Content-Type", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("{}", {
        status: 200,
        headers: {
          "X-Otlp-Accepted": "5",
          "X-Otlp-Rejected": "0",
          "X-Otlp-Batch-Id": "batch-1",
        },
      }),
    );

    const body = { resourceSpans: [] };
    const result = await submitOtlpChunk("http://apo.test", body, APO_CONFIG);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://apo.test/api/public/otel/v1/traces");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer apo-key-test");
    expect(headers.get("content-type")).toBe("application/json");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify(body));

    expect(result.acceptedSpans).toBe(5);
    expect(result.rejectedSpans).toBe(0);
    expect(result.batchId).toBe("batch-1");
  });

  it("returns an ApoAuthError on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"detail":"unauthorized"}', { status: 401 }),
    );
    await expect(
      submitOtlpChunk("http://apo.test", {}, APO_CONFIG),
    ).rejects.toThrow(/auth|unauthor|login/i);
  });

  it("returns a partial-success response (not throws) when some spans were rejected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ partialSuccess: { errorMessage: "boom" } }),
        {
          status: 200,
          headers: {
            "X-Otlp-Accepted": "5",
            "X-Otlp-Rejected": "1",
            "X-Otlp-Batch-Id": "batch-2",
          },
        },
      ),
    );
    const result = await submitOtlpChunk("http://apo.test", {}, APO_CONFIG);
    expect(result.rejectedSpans).toBe(1);
    expect(result.errorMessage).toBe("boom");
  });

  it("throws a backend error on 5xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("server error", { status: 500 }),
    );
    await expect(
      submitOtlpChunk("http://apo.test", {}, APO_CONFIG),
    ).rejects.toThrow(/500|backend/i);
  });
});

describe("pollTraceVisibility", () => {
  function traceResponse(status: number): Response {
    return new Response(
      status === 200 ? JSON.stringify({ run: { id: "trace-1" }, calls: [], metrics: [] }) : '{"detail":"not found"}',
      { status, headers: { "Content-Type": "application/json" } },
    );
  }

  it("resolves once the trace is readable", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(traceResponse(404))
      .mockResolvedValueOnce(traceResponse(404))
      .mockResolvedValueOnce(traceResponse(200));

    await pollTraceVisibility("http://apo.test", "trace-1", APO_CONFIG, {
      totalDeadlineMs: 5_000,
      intervalMs: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects with a visibility timeout after the deadline", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(traceResponse(404));
    await expect(
      pollTraceVisibility("http://apo.test", "trace-1", APO_CONFIG, {
        totalDeadlineMs: 5,
        intervalMs: 1,
      }),
    ).rejects.toThrow(/visibility|timeout|pending/i);
  });

  it("forwards project query param when configured", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(traceResponse(200));
    await pollTraceVisibility("http://apo.test", "trace-1", {
      ...APO_CONFIG,
      projectId: "proj-99",
    }, { totalDeadlineMs: 5_000, intervalMs: 1 });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("project=proj-99");
  });
});

describe("ApoOtlpImportResponse shape", () => {
  it("matches the spec surface", () => {
    const r: ApoOtlpImportResponse = {
      acceptedSpans: 1,
      rejectedSpans: 0,
      batchId: "b",
    };
    expect(r.acceptedSpans).toBe(1);
    expect(r.batchId).toBe("b");
  });
});
