import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Score API (SPEC-129 §5)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("score() is exported and callable", async () => {
    const mod = await import("../src/otel/index.ts");
    expect(typeof mod.score).toBe("function");
  });

  it("calls the trace score endpoint with correct body", async () => {
    const { score } = await import("../src/otel/index.ts");
    await score(
      { traceId: "trace-123", name: "helpfulness", value: 0.85, source: "EVAL" },
      { endpoint: "http://localhost:8000", headers: { Authorization: "Basic xxx" } },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8000/api/v1/traces/trace-123/scores");
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe("helpfulness");
    expect(body.value).toBe(0.85);
    expect(body.data_type).toBe("NUMERIC");
    expect(body.source).toBe("EVAL");
  });

  it("calls the observation score endpoint when observationId is set", async () => {
    const { score } = await import("../src/otel/index.ts");
    await score(
      { traceId: "trace-456", observationId: "span-789", name: "accuracy", value: 1 },
      { endpoint: "http://localhost:8000", headers: {} },
    );

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8000/api/v1/observations/span-789/scores");
  });

  it("includes comment in the body when provided", async () => {
    const { score } = await import("../src/otel/index.ts");
    await score(
      { traceId: "t", name: "n", value: 1, comment: "good answer" },
      { endpoint: "http://localhost:8000", headers: {} },
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.comment).toBe("good answer");
  });

  it("does not throw on fetch failure (best-effort)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));
    const { score } = await import("../src/otel/index.ts");
    // Should not throw — scores are best-effort
    await expect(
      score(
        { traceId: "t", name: "n", value: 1 },
        { endpoint: "http://localhost:8000", headers: {} },
      ),
    ).resolves.toBeUndefined();
  });
});
