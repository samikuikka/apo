import { beforeEach, describe, expect, it, vi } from "vitest";

const { getTraceDetailMock, getAdjacentTracesMock } = vi.hoisted(() => ({
  getTraceDetailMock: vi.fn(),
  getAdjacentTracesMock: vi.fn(),
}));

vi.mock("@/lib/traces-api", () => ({
  getTraceDetail: getTraceDetailMock,
  getAdjacentTraces: getAdjacentTracesMock,
}));

vi.mock("@/components/trace-detail", () => ({
  UrlSelectionProvider: () => null,
  TraceWorkspacePage: () => null,
}));

import TraceDetailPage from "../page";

describe("TraceDetailPage", () => {
  beforeEach(() => {
    getTraceDetailMock.mockReset();
    getAdjacentTracesMock.mockReset();
  });

  it("renders a detail error without waiting for adjacent navigation", async () => {
    getTraceDetailMock.mockRejectedValue(new Error("Trace unavailable"));
    getAdjacentTracesMock.mockReturnValue(new Promise(() => {}));

    const result = await TraceDetailPage({
      params: Promise.resolve({ projectId: "project-1", runId: "run-1" }),
      searchParams: Promise.resolve({}),
    });

    expect(getAdjacentTracesMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).toContain("Trace unavailable");
  });
});
