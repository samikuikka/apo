import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the projection reader so the canonical read-back's polling and floor
// logic can be exercised without a backend. The rest of the module (the
// timeout error class) passes through as the real implementation.
vi.mock("../src/agent-task/trace-projection/remote-capture.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/agent-task/trace-projection/remote-capture.ts")>();
  return { ...actual, readTaskRunProjection: vi.fn() };
});

// Import after mocks are registered.
const { readTaskRunProjection, ProjectionTimeoutError } = await import(
  "../src/agent-task/trace-projection/remote-capture.ts"
);
const { readCanonicalSnapshot } = await import("../src/agent-task/run/runTask");

import type { TraceProjectionSnapshot } from "../src/agent-task/trace-projection/types.ts";

function snapshotWith(observationCount: number): TraceProjectionSnapshot {
  return {
    schemaVersion: 1,
    projectionVersion: 1,
    source: "canonical",
    trace: { traceId: "trace-1", complete: true },
    capabilities: {},
    observations: Array.from({ length: observationCount }, (_, i) => ({
      spanId: `span-${i}`,
      type: "TOOL",
      name: `tool-${i}`,
      status: "ok",
    })),
  } as unknown as TraceProjectionSnapshot;
}

const TRACE = { taskRunId: "run-1" } as Parameters<
  typeof readCanonicalSnapshot
>[0];

const mockedRead = vi.mocked(readTaskRunProjection);

beforeEach(() => {
  mockedRead.mockReset();
  process.env.AGENT_TASK_TRACE_ENDPOINT = "http://localhost:8000";
  process.env.APO_AUTH_TOKEN = "token";
});

afterEach(() => {
  delete process.env.AGENT_TASK_TRACE_ENDPOINT;
  delete process.env.APO_AUTH_TOKEN;
});

describe("readCanonicalSnapshot", () => {
  it("returns null without a taskRunId (offline/local run)", async () => {
    const result = await readCanonicalSnapshot(
      { ...TRACE, taskRunId: undefined },
      4,
    );
    expect(result).toBeNull();
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it("returns a projection that already meets the floor unchanged", async () => {
    mockedRead.mockResolvedValue(snapshotWith(4));
    const result = await readCanonicalSnapshot(TRACE, 4);
    expect(result?.observations.length).toBe(4);
    expect(mockedRead).toHaveBeenCalledTimes(1);
    // Fresh-run readback must wait for the trace claim instead of falling
    // back to the local snapshot on the first 409.
    expect(mockedRead.mock.calls[0][0].retryNoTrace).toBe(true);
  });

  it("keeps polling until the projection reaches the floor", async () => {
    // First read is complete-flagged but still missing in-flight child
    // spans, the exact state that made recorded runs flake.
    mockedRead
      .mockResolvedValueOnce(snapshotWith(1))
      .mockResolvedValueOnce(snapshotWith(2))
      .mockResolvedValue(snapshotWith(4));

    const result = await readCanonicalSnapshot(TRACE, 4);

    expect(result?.observations.length).toBe(4);
    expect(mockedRead).toHaveBeenCalledTimes(3);
  });

  it("falls back to the local snapshot when the floor is never reached", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockedRead.mockResolvedValue(snapshotWith(1));
      // Short deadline so the test does not wait the full 30s budget.
      const result = await readCanonicalSnapshot(TRACE, 4, {
        deadlineMs: 700,
      });
      expect(result).toBeNull();
      expect(mockedRead.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("using the local snapshot"),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns null when the projection read itself fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockedRead.mockRejectedValue(
        new ProjectionTimeoutError("run-1", 30_000),
      );
      const result = await readCanonicalSnapshot(TRACE, 4);
      expect(result).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
