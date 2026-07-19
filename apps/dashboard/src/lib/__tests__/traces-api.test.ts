import { describe, it, expect, vi, beforeEach } from "vitest";

import { getAdjacentTraces, getTraceDetail } from "../traces-api";

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

  it("throws 'Trace not found' on 404", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve(""),
    });

    await expect(getTraceDetail("r1")).rejects.toThrow("Trace not found");
  });
});
