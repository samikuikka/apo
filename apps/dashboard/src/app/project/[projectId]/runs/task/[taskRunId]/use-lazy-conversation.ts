import { useEffect, useState } from "react";
import {
  conversationFromGeneration,
  deriveConversationFromTrace,
  orderedGenerations,
  type ChatMessage,
} from "@/lib/conversation-from-trace";
import { getCallDetail, getTraceDetail } from "@/lib/traces-api";

export type ConversationState =
  | { status: "idle" | "loading" }
  | { status: "ready"; messages: ChatMessage[] }
  | { status: "error"; message: string };

/** How many trailing generations to probe for a messages array before
 * falling back to the full-trace derivation. The chronologically last
 * generation is not always a chat completion (simulated-user turns and
 * LLM judges trace into the same trace), so one probe is not enough. */
const MAX_GENERATION_PROBES = 6;

/**
 * Fetch the linked trace only while the transcript tab is open. Successful
 * results are cached per project+trace, while interrupted or failed requests
 * retry the next time the tab opens. The status itself is derived during
 * render from the request key, so a key change never shows the previous
 * trace's messages for a frame.
 *
 * The trace is fetched slim (call metadata only) — agentic traces repeat the
 * accumulated conversation in every generation's input, so the full payload
 * grows quadratically with length. The conversation lives in the last chat
 * generation's messages, fetched per call; traces where no generation
 * carries messages (imports with provider-native payloads) fall back to one
 * full-trace fetch.
 */
export function useLazyConversation(
  traceRunId: string | null,
  projectId: string | null | undefined,
  enabled: boolean,
): ConversationState {
  const [loaded, setLoaded] = useState<Record<string, ChatMessage[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const requestKey =
    enabled && traceRunId !== null ? `${projectId ?? ""}:${traceRunId}` : null;

  useEffect(() => {
    if (requestKey === null || traceRunId === null || requestKey in loaded) return;
    const controller = new AbortController();
    const fail = (error: unknown) => {
      if (controller.signal.aborted) return;
      setErrors((prev) => ({
        ...prev,
        [requestKey]:
          error instanceof Error ? error.message : "Failed to load transcript",
      }));
    };

    loadConversation(traceRunId, projectId ?? undefined, controller.signal)
      .then((messages) => {
        if (controller.signal.aborted) return;
        setLoaded((prev) => ({ ...prev, [requestKey]: messages }));
      })
      .catch(fail);
    return () => controller.abort();
  }, [requestKey, loaded, traceRunId, projectId]);

  if (!enabled) return { status: "idle" };
  // A running task may receive its trace ID on a later page refresh; until
  // then the transcript is simply empty.
  if (requestKey === null) return { status: "ready", messages: [] };
  if (requestKey in errors) return { status: "error", message: errors[requestKey] };
  if (requestKey in loaded) return { status: "ready", messages: loaded[requestKey] };
  return { status: "loading" };
}

async function loadConversation(
  traceRunId: string,
  projectId: string | undefined,
  signal: AbortSignal,
): Promise<ChatMessage[]> {
  const slim = await getTraceDetail(traceRunId, projectId, signal, { slim: true });

  // Probe trailing generations for a messages array, newest first — the
  // newest chat generation saw the whole accumulated conversation.
  const generations = orderedGenerations(slim);
  const probes = generations.slice(-MAX_GENERATION_PROBES).reverse();
  for (const generation of probes) {
    if (signal.aborted) return [];
    const full = await getCallDetail(traceRunId, generation.id, projectId, signal);
    const messages = conversationFromGeneration(full);
    if (messages.length > 0) return messages;
  }

  // No generation carried messages (e.g. imported traces with provider-native
  // payloads) — reconstruct from every call's raw I/O in one full fetch.
  const full = await getTraceDetail(traceRunId, projectId, signal);
  return deriveConversationFromTrace(full).messages;
}
