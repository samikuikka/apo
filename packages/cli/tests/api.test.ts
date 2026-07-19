import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet, apiPatch, apiPost, isBackendReachable } from "../src/lib/api.ts";

describe("apiGet", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("makes GET request and returns parsed JSON", async () => {
    const data = [{ id: "run-1" }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const result = await apiGet("http://localhost:8000", "/v1/runs");
    expect(result).toEqual(data);
  });

  it("appends query params", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("[]", { status: 200 }),
    );

    await apiGet("http://localhost:8000", "/v1/runs", {
      task_id: "my-task",
      status: "completed",
    });

    const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("task_id=my-task");
    expect(calledUrl).toContain("status=completed");
  });

  it("skips empty/undefined params", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("[]", { status: 200 }),
    );

    await apiGet("http://localhost:8000", "/v1/runs", {
      task_id: "my-task",
      status: "",
    });

    const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("task_id=my-task");
    expect(calledUrl).not.toContain("status=");
  });

  it("throws on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );

    await expect(
      apiGet("http://localhost:8000", "/v1/missing"),
    ).rejects.toThrow("Backend error 404");
  });
});

describe("apiPost", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("makes POST request with JSON body", async () => {
    const responseBody = { id: "new-run" };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await apiPost("http://localhost:8000", "/v1/runs", {
      task: "my-task",
    });
    expect(result).toEqual(responseBody);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const requestInit = call[1] as RequestInit;
    expect(requestInit.method).toBe("POST");
    expect(requestInit.headers).toEqual({ "Content-Type": "application/json" });
    expect(requestInit.body).toBe(JSON.stringify({ task: "my-task" }));
  });

  it("throws on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Bad Request", { status: 400 }),
    );

    await expect(
      apiPost("http://localhost:8000", "/v1/runs", {}),
    ).rejects.toThrow("Backend error 400");
  });
});

describe("apiPatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("makes PATCH request with JSON body", async () => {
    const responseBody = { id: "updated" };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await apiPatch("http://localhost:8000", "/v1/resource", {
      ok: true,
    });
    expect(result).toEqual(responseBody);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const requestInit = call[1] as RequestInit;
    expect(requestInit.method).toBe("PATCH");
    expect(requestInit.headers).toEqual({ "Content-Type": "application/json" });
    expect(requestInit.body).toBe(JSON.stringify({ ok: true }));
  });
});

describe("isBackendReachable", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true on successful health check", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    const result = await isBackendReachable("http://localhost:8000");
    expect(result).toBe(true);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "http://localhost:8000/health",
    );
  });

  it("returns false on connection refused", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("ECONNREFUSED"),
    );

    const result = await isBackendReachable("http://localhost:8000");
    expect(result).toBe(false);
  });

  it("returns false on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 500 }),
    );

    const result = await isBackendReachable("http://localhost:8000");
    expect(result).toBe(false);
  });
});
