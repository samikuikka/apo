"use client";

import { useEffect, useRef, useCallback } from "react";
import { getBrowserBackendBaseUrl, getProjectId } from "@/lib/config";
import { toBrowserProxyUrl } from "@/lib/backend-fetch";

export interface RunEvent {
  event_type: string;
  project: string;
  data: Record<string, unknown>;
  timestamp: string;
}

interface UseRunEventsOptions {
  project?: string;
  enabled: boolean;
  onEvent: (event: RunEvent) => void;
}

const EVENT_TYPES = [
  "batch_run.completed",
  "batch_run.failed",
  "task_run.started",
  "task_run.completed",
  "task_run.error",
  "task_run.trace_claimed",
];

export function useRunEvents({
  project,
  enabled,
  onEvent,
}: UseRunEventsOptions) {
  const resolvedProject = project ?? getProjectId();
  const eventSourceRef = useRef<EventSource | null>(null);
  const handlerRef = useRef<(e: MessageEvent) => void>(() => {});
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEventRef = useRef(onEvent);
  // Written via useEffect (not in the render body) so render stays pure.
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const baseUrl = String(toBrowserProxyUrl(getBrowserBackendBaseUrl()));
    const params = new URLSearchParams({ project: resolvedProject });
    // Cleanup lives in the consuming useEffect (detachAndClose); scanner can't trace it.
    // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
    const es = new EventSource(`${baseUrl}/v1/events?${params}`);

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
      if (enabled) {
        reconnectTimerRef.current = setTimeout(connect, 3000);
      }
    };

    const handleEvent = (e: MessageEvent) => {
      try {
        const event: RunEvent = JSON.parse(e.data);
        onEventRef.current(event);
      } catch {
        // ignore malformed events
      }
    };
    handlerRef.current = handleEvent;

    for (const eventType of EVENT_TYPES) {
      es.addEventListener(eventType, handleEvent);
    }

    eventSourceRef.current = es;
  }, [resolvedProject, enabled]);

  useEffect(() => {
    if (!enabled) {
      if (eventSourceRef.current) {
        detachAndClose(eventSourceRef.current, handlerRef.current);
        eventSourceRef.current = null;
      }
      return;
    }

    connect();

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (eventSourceRef.current) {
        detachAndClose(eventSourceRef.current, handlerRef.current);
        eventSourceRef.current = null;
      }
    };
  }, [enabled, connect]);
}

/** Remove every listener we attached, then close the EventSource. */
function detachAndClose(
  es: EventSource,
  handler: (e: MessageEvent) => void,
): void {
  for (const eventType of EVENT_TYPES) {
    es.removeEventListener(eventType, handler);
  }
  es.close();
}
