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
  listComments,
  createComment,
  deleteComment,
  toggleReaction,
  getCommentCounts,
} from "../comments-api";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

describe("listComments", () => {
  it("returns comments on success", async () => {
    const comments = [
      {
        id: "c1",
        object_id: "trace-1",
        object_type: "trace",
        content: "Hello",
        reactions: [],
      },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(comments),
    });

    const result = await listComments("trace-1", "trace");
    expect(result).toEqual(comments);
    const calledUrl = new URL(mockFetch.mock.calls[0][0]);
    expect(calledUrl.searchParams.get("object_id")).toBe("trace-1");
    expect(calledUrl.searchParams.get("object_type")).toBe("trace");
  });

  it("returns empty array on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
    const result = await listComments("trace-1", "trace");
    expect(result).toEqual([]);
  });

  it("returns empty array on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    const result = await listComments("trace-1", "trace");
    expect(result).toEqual([]);
  });
});

describe("createComment", () => {
  it("posts comment and returns response", async () => {
    const response = {
      id: "c1",
      object_id: "trace-1",
      object_type: "trace",
      content: "Test comment",
      reactions: [],
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(response),
    });

    const result = await createComment({
      object_id: "trace-1",
      object_type: "trace",
      content: "Test comment",
    });
    expect(result).toEqual(response);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/comments"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws on non-ok response with detail", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ detail: "content must not be empty" }),
    });
    await expect(
      createComment({
        object_id: "trace-1",
        object_type: "trace",
        content: "",
      }),
    ).rejects.toThrow("content must not be empty");
  });

  it("throws with status when json parse fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("not json")),
      text: () => Promise.resolve(""),
    });
    await expect(
      createComment({
        object_id: "trace-1",
        object_type: "trace",
        content: "test",
      }),
    ).rejects.toThrow("Request failed (500)");
  });
});

describe("deleteComment", () => {
  it("sends DELETE request", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });
    await deleteComment("c1");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/comments/c1"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("throws on non-ok non-204 response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve(""),
    });
    await expect(deleteComment("c1")).rejects.toThrow("Request failed (404)");
  });
});

describe("toggleReaction", () => {
  it("posts reaction and returns updated comment", async () => {
    const response = {
      id: "c1",
      reactions: [{ emoji: "👍", user_ids: ["user-1"] }],
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(response),
    });

    const result = await toggleReaction("c1", "👍", "user-1");
    expect(result).toEqual(response);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/comments/c1/reactions"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ emoji: "👍", user_id: "user-1" }),
      }),
    );
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ detail: "Comment not found" }),
    });
    await expect(toggleReaction("c1", "👍", "user-1")).rejects.toThrow(
      "Comment not found",
    );
  });
});

describe("getCommentCounts", () => {
  it("returns counts on success", async () => {
    const counts = { "trace-1": 3, "trace-2": 1 };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(counts),
    });

    const result = await getCommentCounts(["trace-1", "trace-2"], "trace");
    expect(result).toEqual(counts);
    const calledUrl = new URL(mockFetch.mock.calls[0][0]);
    expect(calledUrl.searchParams.get("object_ids")).toBe("trace-1,trace-2");
    expect(calledUrl.searchParams.get("object_type")).toBe("trace");
  });

  it("returns empty object for empty input", async () => {
    const result = await getCommentCounts([], "trace");
    expect(result).toEqual({});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns empty object on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
    const result = await getCommentCounts(["trace-1"], "trace");
    expect(result).toEqual({});
  });

  it("returns empty object on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("fail"));
    const result = await getCommentCounts(["trace-1"], "trace");
    expect(result).toEqual({});
  });
});
