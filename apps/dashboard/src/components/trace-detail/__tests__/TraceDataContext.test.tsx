import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import {
  TraceDataProvider,
  useTraceData,
  LARGE_TRACE_THRESHOLD,
  GRAPH_DISABLED_THRESHOLD,
  SIMPLIFIED_TREE_THRESHOLD,
} from "../contexts";
import type { TraceDetail, LoggedCall } from "../contexts";

function makeCall(overrides: Partial<LoggedCall> & { id: string }): LoggedCall {
  return {
    step_index: 0,
    step_name: null,
    model: "unknown",
    created_at: "2026-01-01T00:00:00.000Z",
    latency_ms: 100,
    cost: null,
    input: null,
    output: null,
    task_id: null,
    parent_call_id: null,
    ...overrides,
  };
}

function makeTraceDetail(callCount: number): TraceDetail {
  const calls = Array.from({ length: callCount }, (_, i) =>
    makeCall({ id: `call-${i}`, step_name: `Step ${i}` }),
  );
  return {
    run: {
      id: "run-1",
      project: "test",
      scopeKey: null,
      created_at: "2026-01-01T00:00:00.000Z",
      call_count: callCount,
    },
    metrics: [],
    calls,
  };
}

function Consumer() {
  const {
    prefetchedCalls,
    prefetchObservation,
    isPrefetched,
    callCount,
    isLargeTrace,
    isGraphDisabled,
    isSimplifiedTree,
  } = useTraceData();
  return (
    <div>
      <span data-testid="callCount">{callCount}</span>
      <span data-testid="isLargeTrace">{String(isLargeTrace)}</span>
      <span data-testid="isGraphDisabled">{String(isGraphDisabled)}</span>
      <span data-testid="isSimplifiedTree">{String(isSimplifiedTree)}</span>
      <span data-testid="prefetchedCount">{prefetchedCalls.size}</span>
      <span data-testid="isPrefetched-a">{String(isPrefetched("a"))}</span>
      <button
        type="button"
        data-testid="prefetch-a"
        onClick={() => prefetchObservation("a")}
      />
      <button
        type="button"
        data-testid="prefetch-b"
        onClick={() => prefetchObservation("b")}
      />
    </div>
  );
}

function renderWithProvider(ui: React.ReactElement, run: TraceDetail | null) {
  return render(
    <TraceDataProvider run={run} isLoading={false} error={null}>
      {ui}
    </TraceDataProvider>,
  );
}

describe("TraceDataContext - performance thresholds", () => {
  it("exports correct threshold constants", () => {
    expect(LARGE_TRACE_THRESHOLD).toBe(100);
    expect(GRAPH_DISABLED_THRESHOLD).toBe(500);
    expect(SIMPLIFIED_TREE_THRESHOLD).toBe(1000);
  });

  it("reports normal trace for <= 100 calls", () => {
    const run = makeTraceDetail(100);
    renderWithProvider(<Consumer />, run);

    expect(screen.getByTestId("callCount").textContent).toBe("100");
    expect(screen.getByTestId("isLargeTrace").textContent).toBe("false");
    expect(screen.getByTestId("isGraphDisabled").textContent).toBe("false");
    expect(screen.getByTestId("isSimplifiedTree").textContent).toBe("false");
  });

  it("reports large trace for 101 calls", () => {
    const run = makeTraceDetail(101);
    renderWithProvider(<Consumer />, run);

    expect(screen.getByTestId("isLargeTrace").textContent).toBe("true");
    expect(screen.getByTestId("isGraphDisabled").textContent).toBe("false");
    expect(screen.getByTestId("isSimplifiedTree").textContent).toBe("false");
  });

  it("reports graph disabled for 501 calls", () => {
    const run = makeTraceDetail(501);
    renderWithProvider(<Consumer />, run);

    expect(screen.getByTestId("isLargeTrace").textContent).toBe("true");
    expect(screen.getByTestId("isGraphDisabled").textContent).toBe("true");
    expect(screen.getByTestId("isSimplifiedTree").textContent).toBe("false");
  });

  it("reports simplified tree for 1001 calls", () => {
    const run = makeTraceDetail(1001);
    renderWithProvider(<Consumer />, run);

    expect(screen.getByTestId("isLargeTrace").textContent).toBe("true");
    expect(screen.getByTestId("isGraphDisabled").textContent).toBe("true");
    expect(screen.getByTestId("isSimplifiedTree").textContent).toBe("true");
  });

  it("reports all false for null run", () => {
    renderWithProvider(<Consumer />, null);

    expect(screen.getByTestId("callCount").textContent).toBe("0");
    expect(screen.getByTestId("isLargeTrace").textContent).toBe("false");
    expect(screen.getByTestId("isGraphDisabled").textContent).toBe("false");
    expect(screen.getByTestId("isSimplifiedTree").textContent).toBe("false");
  });
});

describe("TraceDataContext - prefetch cache", () => {
  it("starts with empty prefetch cache", () => {
    const run = makeTraceDetail(5);
    renderWithProvider(<Consumer />, run);

    expect(screen.getByTestId("prefetchedCount").textContent).toBe("0");
    expect(screen.getByTestId("isPrefetched-a").textContent).toBe("false");
  });

  it("marks observation as prefetched after prefetchObservation call", () => {
    const run = makeTraceDetail(5);
    renderWithProvider(<Consumer />, run);

    act(() => {
      screen.getByTestId("prefetch-a").click();
    });

    expect(screen.getByTestId("isPrefetched-a").textContent).toBe("true");
    expect(screen.getByTestId("prefetchedCount").textContent).toBe("1");
  });

  it("does not duplicate prefetched entries", () => {
    const run = makeTraceDetail(5);
    renderWithProvider(<Consumer />, run);

    act(() => {
      screen.getByTestId("prefetch-a").click();
      screen.getByTestId("prefetch-a").click();
    });

    expect(screen.getByTestId("prefetchedCount").textContent).toBe("1");
  });

  it("tracks multiple prefetched observations independently", () => {
    const run = makeTraceDetail(5);
    renderWithProvider(<Consumer />, run);

    act(() => {
      screen.getByTestId("prefetch-a").click();
      screen.getByTestId("prefetch-b").click();
    });

    expect(screen.getByTestId("isPrefetched-a").textContent).toBe("true");
    expect(screen.getByTestId("prefetchedCount").textContent).toBe("2");
  });
});

describe("TraceDataContext - throw outside provider", () => {
  it("throws when useTraceData is used outside TraceDataProvider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      render(<Consumer />);
    }).toThrow("useTraceData must be used within TraceDataProvider");

    consoleError.mockRestore();
  });
});
