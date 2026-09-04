import { describe, it, expect, vi, beforeEach } from "vitest";

import { getAdjacentTraces, getCallDetail, getTraceDetail } from "../traces-api";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

describe("getAdjacentTraces", () => {
  it("returns adjacent runs on success", async () => {
    const adjacent = { prev_id: "run-1", next_id: "run-3" };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(adjacent),
    });

    const result = await getAdjacentTraces("run-2");
    expect(result).toEqual(adjacent);
    expect(mockFetch.mock.calls[0][0]).toContain("/v1/runs/run-2/adjacent");
  });

  it("passes sort params when provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ prev_id: null, next_id: "r2" }),
    });

    await getAdjacentTraces("r1", "duration_ms", "asc");

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("sort_by=duration_ms");
    expect(calledUrl).toContain("sort_order=asc");
  });

  it("omits sort params when not provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ prev_id: null, next_id: null }),
    });

    await getAdjacentTraces("r1");

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).not.toContain("sort_by");
    expect(calledUrl).not.toContain("sort_order");
  });

  it("sends project param when provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ prev_id: null, next_id: null }),
    });

    await getAdjacentTraces("r1", undefined, undefined, "proj-123");

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("project=proj-123");
  });

  it("omits project param when not provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ prev_id: null, next_id: null }),
    });

    await getAdjacentTraces("r1");

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).not.toContain("project=");
  });

  it("returns nulls on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await getAdjacentTraces("r1");
    expect(result).toEqual({ prev_id: null, next_id: null });
  });
});

describe("getTraceDetail", () => {
  const sampleDetail = {
    run: { id: "r1", flow_name: null },
    metrics: [],
    calls: [],
  };

  it("sends project param when provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(sampleDetail),
    });

    await getTraceDetail("r1", "proj-123");

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/v1/runs/r1");
    expect(calledUrl).toContain("project=proj-123");
  });

  it("omits project param when not provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(sampleDetail),
    });

    await getTraceDetail("r1");

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/v1/runs/r1");
    expect(calledUrl).not.toContain("project=");
  });

  it("passes an abort signal to the request", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(sampleDetail),
    });
    const controller = new AbortController();

    await getTraceDetail("r1", "proj-123", controller.signal);

    expect(mockFetch.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it("throws 'Trace not found' on 404", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve(""),
    });

    await expect(getTraceDetail("r1")).rejects.toThrow("Trace not found");
  });

  it("sends slim=true only when requested", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(sampleDetail),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(sampleDetail),
    });

    await getTraceDetail("r1", "proj-123", undefined, { slim: true });
    await getTraceDetail("r1", "proj-123");

    const slimUrl = mockFetch.mock.calls[0][0] as string;
    const fullUrl = mockFetch.mock.calls[1][0] as string;
    expect(slimUrl).toContain("slim=true");
    expect(fullUrl).not.toContain("slim=");
  });

  it("normalizes the slim_calls marker through to the caller", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ...sampleDetail, slim_calls: true }),
    });

    const detail = await getTraceDetail("r1", "proj-123", undefined, {
      slim: true,
    });

    expect(detail.slim_calls).toBe(true);
    expect(detail.run.scopeKey).toBeNull();
  });
});

describe("getCallDetail", () => {
  it("fetches one call scoped by run, call and project", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: "c1", input: { a: 1 } }),
    });
    const controller = new AbortController();

    await getCallDetail("r1", "c1", "proj-123", controller.signal);

    const [calledUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("/v1/runs/r1/calls/c1");
    expect(calledUrl).toContain("project=proj-123");
    expect(init?.signal).toBe(controller.signal);
  });
});
