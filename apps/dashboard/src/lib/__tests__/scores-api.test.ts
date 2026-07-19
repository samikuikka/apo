import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config so URL building produces a parseable absolute URL.
vi.mock("../config", () => ({
  getBrowserBackendBaseUrl: () => "http://localhost:8000",
}));

// Mock backendFetch so it passes straight through to globalThis.fetch.
// This bypasses the server-side proxy rewriting (which imports next/headers)
// and lets the tests assert on the URL that apiClient actually built.
vi.mock("../backend-fetch", () => ({
  backendFetch: (url: string, init: RequestInit) => fetch(url, init),
}));

import {
  getScoreConfigs,
  createTraceScore,
  createObservationScore,
  getTraceScores,
} from "../scores-api";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

describe("getScoreConfigs", () => {
  it("returns configs on success", async () => {
    const configs = [{ id: 1, name: "correctness", data_type: "NUMERIC" }];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(configs),
    });

    const result = await getScoreConfigs("my-project");
    expect(result).toEqual(configs);
    const calledUrl = new URL(mockFetch.mock.calls[0][0]);
    expect(calledUrl.searchParams.get("project")).toBe("my-project");
  });

  it("returns empty array on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
    const result = await getScoreConfigs();
    expect(result).toEqual([]);
  });

  it("returns empty array on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    const result = await getScoreConfigs();
    expect(result).toEqual([]);
  });
});

describe("createTraceScore", () => {
  it("posts score and returns response", async () => {
    const scoreResponse = {
      id: 1,
      trace_id: "trace-1",
      observation_id: null,
      name: "quality",
      value: 0.9,
      string_value: null,
      data_type: "NUMERIC",
      source: "ANNOTATION",
      config_id: 1,
      comment: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(scoreResponse),
    });

    const request = {
      name: "quality",
      value: 0.9,
      data_type: "NUMERIC",
      source: "ANNOTATION",
    };
    const result = await createTraceScore("trace-1", request);

    expect(result).toEqual(scoreResponse);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/traces/trace-1/scores"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ detail: "Invalid score" }),
    });

    await expect(
      createTraceScore("trace-1", {
        name: "q",
        value: 0.5,
        data_type: "NUMERIC",
      }),
    ).rejects.toThrow("Invalid score");
  });

  it("throws with status when json parse fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("not json")),
      text: () => Promise.resolve(""),
    });

    await expect(
      createTraceScore("trace-1", {
        name: "q",
        value: 0.5,
        data_type: "NUMERIC",
      }),
    ).rejects.toThrow("Failed to create score: 500");
  });
});

describe("createObservationScore", () => {
  it("posts score to observation endpoint", async () => {
    const scoreResponse = {
      id: 2,
      trace_id: null,
      observation_id: "obs-1",
      name: "helpful",
      value: true,
      string_value: null,
      data_type: "BOOLEAN",
      source: "ANNOTATION",
      config_id: 2,
      comment: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(scoreResponse),
    });

    const result = await createObservationScore("obs-1", {
      name: "helpful",
      value: true,
      data_type: "BOOLEAN",
    });
    expect(result).toEqual(scoreResponse);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/observations/obs-1/scores"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("getTraceScores", () => {
  it("returns scores for a trace", async () => {
    const scores = [
      { id: 1, name: "quality", value: 0.85, data_type: "NUMERIC" },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(scores),
    });

    const result = await getTraceScores("trace-1");
    expect(result).toEqual(scores);
  });

  it("returns empty array on error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("fail"));
    const result = await getTraceScores("trace-1");
    expect(result).toEqual([]);
  });
});
