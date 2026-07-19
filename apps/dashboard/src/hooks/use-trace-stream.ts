"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { getBrowserBackendBaseUrl } from "@/lib/config";
import { toBrowserProxyUrl } from "@/lib/backend-fetch";
import type { LoggedCall } from "@/components/trace-detail";

interface TraceSSEData {
  id: string;
  parent_call_id?: string | null;
  created_at?: string;
  latency_ms?: number | null;
  model?: string;
  step_name?: string | null;
  step_index?: number | null;
  observation_type?: string;
  level?: string;
  cost?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  time_to_first_token_ms?: number | null;
  status_message?: string | null;
  tool_name?: string | null;
  end_time?: string | null;
  name?: string | null;
  status?: string;
}

function normalizeCall(data: TraceSSEData): Partial<LoggedCall> {
  return {
    id: data.id,
    parent_call_id: data.parent_call_id ?? null,
    created_at: data.created_at ?? new Date().toISOString(),
    latency_ms: data.latency_ms ?? null,
    model: data.model ?? "unknown",
    step_name: data.step_name ?? data.name ?? null,
    step_index: data.step_index ?? null,
    observation_type: data.observation_type ?? "GENERATION",
    level: data.level ?? "DEFAULT",
    cost: data.cost ?? null,
    prompt_tokens: data.prompt_tokens ?? null,
    completion_tokens: data.completion_tokens ?? null,
    total_tokens: data.total_tokens ?? null,
    time_to_first_token_ms: data.time_to_first_token_ms ?? null,
    status_message: data.status_message ?? null,
    tool_name: data.tool_name ?? null,
    end_time: data.end_time ?? null,
  };
}

export function useTraceStream(traceId: string | null) {
  const [calls, setCalls] = useState<LoggedCall[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [prevTraceId, setPrevTraceId] = useState(traceId);
  const esRef = useRef<EventSource | null>(null);
  const handlerRef = useRef<(e: MessageEvent) => void>(() => {});
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once the stream has been deliberately closed (terminal event, unmount,
  // or traceId cleared). Suppresses the onerror-driven reconnect so a blip after
  // completion — or the close itself firing onerror — can't spin up reconnects.
  const closedByUsRef = useRef(false);
  // Reconnect attempt counter for exponential backoff with a hard cap. Reset to
  // 0 on every successful connect so a stable connection doesn't keep backing off.
  const attemptsRef = useRef(0);

  // Reset stream state when traceId changes/clears, done during render via the
  // prev-prop comparison pattern rather than inside the connect effect.
  if (traceId !== prevTraceId) {
    setPrevTraceId(traceId);
    if (!traceId) {
      setCalls([]);
      setIsLive(false);
    }
  }

  const connect = useCallback((id: string) => {
    if (esRef.current) {
      esRef.current.close();
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    // A fresh connect clears the "deliberately closed" flag and resets the
    // backoff counter. Calls already received are preserved across reconnects —
    // only the traceId-change path (in the render-phase block above) wipes them.
    closedByUsRef.current = false;
    attemptsRef.current = 0;

    setIsLive(true);

    const baseUrl = String(toBrowserProxyUrl(getBrowserBackendBaseUrl()));
    // Cleanup lives in the consuming useEffect (detachAndClose); scanner can't trace it.
    // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
    const es = new EventSource(`${baseUrl}/v1/traces/${id}/stream`);
    esRef.current = es;

    es.onerror = () => {
      es.close();
      esRef.current = null;
      setIsLive(false);
      // Terminal close (trace completed, unmount, traceId cleared) must not
      // reconnect. Otherwise back off exponentially (3s, 6s, 12s, 15s, 15s)
      // and give up after MAX_RECONNECT_ATTEMPTS so a persistently failing
      // endpoint can't hammer the backend forever.
      if (closedByUsRef.current) return;
      attemptsRef.current += 1;
      if (attemptsRef.current > MAX_RECONNECT_ATTEMPTS) return;
      const delay = Math.min(
        BASE_RECONNECT_MS * 2 ** (attemptsRef.current - 1),
        MAX_RECONNECT_MS,
      );
      reconnectTimerRef.current = setTimeout(() => connect(id), delay);
    };

    const handleEvent = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data);
        const data: TraceSSEData = event.data || {};

        if (event.event_type === "trace:created") {
          return;
        }
        if (event.event_type === "trace:completed") {
          setIsLive(false);
          // Terminal event: close the stream and arm the "closed by us" flag so
          // the onerror that close() may fire — or any later blip — cannot
          // reconnect a trace that is already finished.
          closedByUsRef.current = true;
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          if (esRef.current) {
            detachAndClose(esRef.current, handlerRef.current);
            esRef.current = null;
          }
          return;
        }

        const normalized = normalizeCall(data);

        if (event.event_type === "span:created") {
          setCalls((prev) => {
            if (prev.some((c) => c.id === normalized.id)) return prev;
            return [...prev, normalized as LoggedCall];
          });
        } else if (event.event_type === "span:updated") {
          setCalls((prev) =>
            prev.map((c) =>
              c.id === normalized.id ? { ...c, ...normalized } : c,
            ),
          );
        }
      } catch {
        // ignore malformed events
      }
    };
    handlerRef.current = handleEvent;

    for (const type of TRACE_EVENT_TYPES) {
      es.addEventListener(type, handleEvent);
    }
  }, []);

  useEffect(() => {
    if (!traceId) {
      if (esRef.current) {
        detachAndClose(esRef.current, handlerRef.current);
        esRef.current = null;
      }
      return;
    }

    connect(traceId);

    return () => {
      // Suppress any reconnect from an unmount-triggered close.
      closedByUsRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (esRef.current) {
        detachAndClose(esRef.current, handlerRef.current);
        esRef.current = null;
      }
    };
  }, [traceId, connect]);

  return { calls, isLive };
}

const TRACE_EVENT_TYPES = ["trace:created", "span:created", "span:updated", "trace:completed"];

/** Base delay (ms) for the first reconnect attempt; doubles each attempt up to the cap. */
const BASE_RECONNECT_MS = 3000;
/** Upper bound (ms) on a single reconnect backoff delay. */
const MAX_RECONNECT_MS = 15000;
/** Give up reconnecting after this many consecutive failed attempts. */
const MAX_RECONNECT_ATTEMPTS = 5;

/** Remove every listener we attached, then close the EventSource. */
function detachAndClose(
  es: EventSource,
  handler: (e: MessageEvent) => void,
): void {
  for (const type of TRACE_EVENT_TYPES) {
    es.removeEventListener(type, handler);
  }
  es.close();
}
