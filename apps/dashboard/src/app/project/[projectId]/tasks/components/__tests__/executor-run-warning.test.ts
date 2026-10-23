import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { getConnectedExecutorStatus } from "@/lib/agent-task-api";

import { executorRunWarning, useConnectedExecutorState } from "../executor-run-warning";

vi.mock("@/lib/agent-task-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-task-api")>(
    "@/lib/agent-task-api",
  );
  return { ...actual, getConnectedExecutorStatus: vi.fn() };
});

describe("executorRunWarning", () => {
  it("is silent when an executor will claim the run", () => {
    expect(executorRunWarning("ready")).toBeNull();
    expect(executorRunWarning("busy")).toBeNull();
    expect(executorRunWarning(null)).toBeNull();
  });

  it.each([
    ["not_connected", "Not connected", "run apo connect"],
    ["offline", "Offline", "restart apo connect"],
    ["incompatible", "CLI outdated", "update, then reconnect"],
    ["catalog_mismatch", "Catalog mismatch", "publish or pull your tasks"],
  ] as const)("warns for %s with a one-phrase strip and the fix", (state, label, fix) => {
    const warning = executorRunWarning(state);
    expect(warning?.label).toBe(label);
    expect(warning?.fix).toBe(fix);
    // The queue-expiry sentence is disclosure material, never strip material.
    expect(warning?.detail).toContain("expire after 24 hours");
    expect(warning?.label).not.toContain("24 hours");
    expect(warning?.fix).not.toContain("24 hours");
  });

  it("does not tell a member with a stale checkout to publish over a newer catalog", () => {
    expect(executorRunWarning("catalog_mismatch")?.detail).toContain(
      "apo task publish if your copy is newer",
    );
  });
});

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

describe("useConnectedExecutorState", () => {
  beforeEach(() => {
    vi.mocked(getConnectedExecutorStatus).mockReset();
    setHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    setHidden(false);
  });

  it("drops the previous answer while a new selection reloads", async () => {
    vi.mocked(getConnectedExecutorStatus).mockResolvedValueOnce({ state: "offline" });
    const { result, rerender } = renderHook(
      ({ enabled }) => useConnectedExecutorState("acme", enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current).toBe("offline"));

    vi.mocked(getConnectedExecutorStatus).mockReturnValue(new Promise(() => {}));
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(result.current).toBeNull();
  });

  it("skips polls while the tab is hidden and refetches when it returns", async () => {
    vi.mocked(getConnectedExecutorStatus).mockResolvedValue({ state: "ready" });
    setHidden(true);
    renderHook(() => useConnectedExecutorState("acme", true));
    expect(getConnectedExecutorStatus).not.toHaveBeenCalled();

    setHidden(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(getConnectedExecutorStatus).toHaveBeenCalledTimes(1));
  });

  it("drops the previous project's answer when the project changes", async () => {
    vi.mocked(getConnectedExecutorStatus).mockResolvedValueOnce({ state: "offline" });
    const { result, rerender } = renderHook(
      ({ projectId }) => useConnectedExecutorState(projectId, true),
      { initialProps: { projectId: "acme" } },
    );
    await waitFor(() => expect(result.current).toBe("offline"));

    vi.mocked(getConnectedExecutorStatus).mockReturnValue(new Promise(() => {}));
    rerender({ projectId: "other" });
    expect(result.current).toBeNull();
    expect(getConnectedExecutorStatus).toHaveBeenLastCalledWith("other", expect.any(AbortSignal));
  });

  it("polls again once the previous request has settled", async () => {
    vi.useFakeTimers();
    vi.mocked(getConnectedExecutorStatus).mockResolvedValue({ state: "ready" });
    renderHook(() => useConnectedExecutorState("acme", true));
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(getConnectedExecutorStatus).toHaveBeenCalledTimes(2);
  });

  it("aborts a hung request so polling resumes", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.mocked(getConnectedExecutorStatus).mockImplementation(
      (_projectId, signal) =>
        new Promise((_resolve, reject) => {
          if (signal) signals.push(signal);
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    renderHook(() => useConnectedExecutorState("acme", true));

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(signals[0].aborted).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(getConnectedExecutorStatus).toHaveBeenCalledTimes(2);
  });

  it("aborts the request in flight on unmount", () => {
    let signal: AbortSignal | undefined;
    vi.mocked(getConnectedExecutorStatus).mockImplementation((_projectId, s) => {
      signal = s;
      return new Promise(() => {});
    });
    const { unmount } = renderHook(() => useConnectedExecutorState("acme", true));
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("does not start a poll while one is in flight", () => {
    vi.useFakeTimers();
    vi.mocked(getConnectedExecutorStatus).mockReturnValue(new Promise(() => {}));
    renderHook(() => useConnectedExecutorState("acme", true));

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(getConnectedExecutorStatus).toHaveBeenCalledTimes(1);
  });
});
