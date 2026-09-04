import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getTraceDetailMock = vi.hoisted(() => vi.fn());
const getCallDetailMock = vi.hoisted(() => vi.fn());
const orderedGenerationsMock = vi.hoisted(() => vi.fn());
const conversationFromGenerationMock = vi.hoisted(() => vi.fn());
const deriveConversationFromTraceMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/traces-api", () => ({
  getTraceDetail: getTraceDetailMock,
  getCallDetail: getCallDetailMock,
}));

vi.mock("@/lib/conversation-from-trace", () => ({
  orderedGenerations: orderedGenerationsMock,
  conversationFromGeneration: conversationFromGenerationMock,
  deriveConversationFromTrace: deriveConversationFromTraceMock,
}));

import { useLazyConversation } from "./use-lazy-conversation";

describe("useLazyConversation", () => {
  beforeEach(() => {
    getTraceDetailMock.mockReset();
    getTraceDetailMock.mockReturnValue(new Promise(() => {}));
    getCallDetailMock.mockReset();
    orderedGenerationsMock.mockReset().mockReturnValue([]);
    conversationFromGenerationMock.mockReset().mockReturnValue([]);
    deriveConversationFromTraceMock.mockReset().mockReturnValue({ messages: [] });
  });

  it("starts loading when a running task receives its trace ID later", () => {
    const { result, rerender } = renderHook(
      ({ traceRunId }) =>
        useLazyConversation(traceRunId, "project-1", true),
      { initialProps: { traceRunId: null as string | null } },
    );
    expect(result.current).toEqual({ status: "ready", messages: [] });

    rerender({ traceRunId: "trace-1" });

    expect(result.current.status).toBe("loading");
    expect(getTraceDetailMock).toHaveBeenCalledOnce();
    expect(getTraceDetailMock).toHaveBeenCalledWith(
      "trace-1",
      "project-1",
      expect.any(AbortSignal),
      { slim: true },
    );
  });

  it("aborts an interrupted load and retries when the tab reopens", () => {
    const { rerender } = renderHook(
      ({ enabled }) =>
        useLazyConversation("trace-1", "project-1", enabled),
      { initialProps: { enabled: true } },
    );
    const firstSignal = getTraceDetailMock.mock.calls[0][2] as AbortSignal;

    act(() => rerender({ enabled: false }));
    expect(firstSignal.aborted).toBe(true);

    act(() => rerender({ enabled: true }));
    expect(getTraceDetailMock).toHaveBeenCalledTimes(2);
    const secondSignal = getTraceDetailMock.mock.calls[1][2] as AbortSignal;
    expect(secondSignal.aborted).toBe(false);
  });

  it("resolves the conversation from the last generation that carries messages", async () => {
    const messages = [{ role: "user", content: "hi" }];
    getTraceDetailMock.mockResolvedValueOnce({ calls: [] }); // slim fetch
    orderedGenerationsMock.mockReturnValue([
      { id: "gen-1" },
      { id: "gen-2" },
    ]);
    getCallDetailMock
      .mockResolvedValueOnce({ id: "gen-2" }) // newest, no messages
      .mockResolvedValueOnce({ id: "gen-1" });
    conversationFromGenerationMock
      .mockReturnValueOnce([])
      .mockReturnValueOnce(messages);

    const { result } = renderHook(() =>
      useLazyConversation("trace-1", "project-1", true),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toEqual({ status: "ready", messages });
    expect(getCallDetailMock).toHaveBeenCalledWith(
      "trace-1",
      "gen-2",
      "project-1",
      expect.any(AbortSignal),
    );
    // One slim trace fetch + per-call probes — never a second full fetch.
    expect(getTraceDetailMock).toHaveBeenCalledOnce();
  });

  it("falls back to one full-trace fetch when no generation carries messages", async () => {
    orderedGenerationsMock.mockReturnValue([{ id: "gen-1" }]);
    getCallDetailMock.mockResolvedValue({ id: "gen-1" });
    conversationFromGenerationMock.mockReturnValue([]);
    const messages = [{ role: "assistant", content: "imported" }];
    deriveConversationFromTraceMock.mockReturnValue({ messages });
    getTraceDetailMock
      .mockResolvedValueOnce({ calls: [] }) // slim fetch
      .mockResolvedValueOnce({ calls: [] }); // fallback full fetch

    const { result } = renderHook(() =>
      useLazyConversation("trace-1", "project-1", true),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toEqual({ status: "ready", messages });
    expect(getTraceDetailMock).toHaveBeenCalledTimes(2);
    expect(getTraceDetailMock.mock.calls[1][3]).toBeUndefined();
  });

  it("surfaces a failed fetch as an error state", async () => {
    getTraceDetailMock.mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() =>
      useLazyConversation("trace-1", "project-1", true),
    );

    await waitFor(() => expect(result.current.status).toBe("error"));
    if (result.current.status === "error") {
      expect(result.current.message).toBe("boom");
    }
  });
});
