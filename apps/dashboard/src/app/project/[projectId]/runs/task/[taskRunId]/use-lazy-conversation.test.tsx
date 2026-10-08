import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getTraceDetailMock = vi.hoisted(() => vi.fn());
const getCallDetailMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/traces-api", () => ({
  getTraceDetail: getTraceDetailMock,
  getCallDetail: getCallDetailMock,
}));

// Only the API boundary is mocked — the selection logic
// (orderedGenerations / conversationProbeOrder / conversationFromGeneration /
// deriveConversationFromTrace) runs for real, so probe-order regressions fail
// here, not only in the lib tests.
import { useLazyConversation } from "./use-lazy-conversation";
import type { LoggedCall } from "@/components/trace-detail/contexts";

/** A metadata-only call, as a `?slim=true` trace fetch returns. */
function slimCall(id: string, stepName: string, index: number): LoggedCall {
  return {
    id,
    step_index: index,
    step_name: stepName,
    model: "m",
    created_at: `2026-07-27T10:00:0${index}Z`,
    task_id: "t",
    observation_type: "GENERATION",
    input: {},
    output: {},
  };
}

/** A full-payload call detail: the generation's accumulated conversation. */
function detailWithMessages(id: string, messages: unknown[]): LoggedCall {
  return { ...slimCall(id, "agent.generate", 0), input: { messages }, output: {} };
}

describe("useLazyConversation", () => {
  beforeEach(() => {
    getTraceDetailMock.mockReset();
    getTraceDetailMock.mockReturnValue(new Promise(() => {}));
    getCallDetailMock.mockReset();
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

  it("resolves the conversation from the last agent generation that carries messages", async () => {
    const messages = [{ role: "user", content: "hi" }];
    getTraceDetailMock.mockResolvedValueOnce({
      calls: [slimCall("gen-1", "agent.generate", 0), slimCall("gen-2", "agent.generate", 1)],
    });
    getCallDetailMock
      .mockResolvedValueOnce(detailWithMessages("gen-2", [])) // newest, no messages
      .mockResolvedValueOnce(detailWithMessages("gen-1", messages));

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

  it("probes the agent's generation, not a trailing judge's (issue #412)", async () => {
    // Judge spans are GENERATION calls whose wrapped {model, instruction}
    // input and verdict output form a fake 2-message conversation, and they
    // trail the agent's last turn. The probe order must reach the agent's
    // generation without being captured by the judge — and must not waste a
    // call-detail fetch on it.
    const agentMessages = [
      { role: "user", content: "Create the shared progress tracker." },
      { role: "assistant", content: "Tracker created." },
    ];
    const judgeMessages = [
      { role: "system", content: '{"model":"m","instruction":"The tracker exists."}' },
      { role: "assistant", content: '{"reasoning":"It does.","pass":true}' },
    ];
    getTraceDetailMock.mockResolvedValueOnce({
      calls: [
        slimCall("gen-agent", "agent.generate", 0),
        slimCall("gen-judge", "judge:tracker-created", 1),
      ],
    });
    getCallDetailMock.mockImplementation(async (_traceId: string, callId: string) =>
      callId === "gen-agent"
        ? detailWithMessages("gen-agent", agentMessages)
        : detailWithMessages("gen-judge", judgeMessages),
    );

    const { result } = renderHook(() =>
      useLazyConversation("trace-1", "project-1", true),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toEqual({ status: "ready", messages: agentMessages });
    expect(getCallDetailMock).toHaveBeenCalledTimes(1);
    expect(getCallDetailMock).toHaveBeenCalledWith(
      "trace-1",
      "gen-agent",
      "project-1",
      expect.any(AbortSignal),
    );
  });

  it("falls back to one full-trace fetch when no generation carries messages", async () => {
    getTraceDetailMock
      .mockResolvedValueOnce({ calls: [slimCall("gen-1", "gen_ai.chat", 0)] }) // slim fetch
      .mockResolvedValueOnce({
        // fallback full fetch: provider-native payloads, reconstructed raw
        calls: [
          {
            ...slimCall("gen-1", "gen_ai.chat", 0),
            input: "What plans do you offer?",
            output: [{ type: "text", text: "We offer Starter and Business plans." }],
          },
        ],
      });
    getCallDetailMock.mockResolvedValue(detailWithMessages("gen-1", []));

    const { result } = renderHook(() =>
      useLazyConversation("trace-1", "project-1", true),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    if (result.current.status === "ready") {
      const assistant = result.current.messages.find((m) => m.role === "assistant");
      expect(assistant?.content).toContain("Starter and Business");
    }
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
