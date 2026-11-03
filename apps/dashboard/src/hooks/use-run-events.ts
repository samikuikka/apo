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
  /**
   * Called when the stream comes back after a drop. Events published while
   * disconnected are gone for good — the backend replays running state on
   * connect, but never terminal states — so consumers must treat a reconnect
   * as "anything may have happened" and re-fetch (router.refresh()).
   */
  onReconnect?: () => void;
  /** Called on every successful open, the first one included. */
  onOpen?: () => void;
  /**
   * Close the stream while the tab is hidden and reopen it (reported as a
   * reconnect) when the tab is seen again. For list pages that hold a stream
   * with nothing running: a forgotten tab should not keep a backend stream
   * open, nor re-render its page on every event nobody is looking at.
   */
  closeWhenHidden?: boolean;
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
  onReconnect,
  onOpen,
  closeWhenHidden = false,
}: UseRunEventsOptions) {
  const resolvedProject = project ?? getProjectId();
  const eventSourceRef = useRef<EventSource | null>(null);
  const handlerRef = useRef<(e: MessageEvent) => void>(() => {});
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Reconnect attempt counter for exponential backoff with a hard cap (same
  // policy as use-trace-stream). Reset on every successful open so a stable
  // connection doesn't keep backing off.
  const attemptsRef = useRef(0);
  // Set when a reconnect came due while the tab was hidden; the
  // visibilitychange listener resumes it instead of hammering a backgrounded
  // page's backend.
  const reconnectOnVisibleRef = useRef(false);
  // True from the moment a connection drops until the next successful open,
  // so that open can be reported as a reconnect (a gap events may have
  // fallen into) rather than a first connect.
  const droppedRef = useRef(false);
  const onEventRef = useRef(onEvent);
  const onReconnectRef = useRef(onReconnect);
  const onOpenRef = useRef(onOpen);
  // Written via useEffect (not in the render body) so render stays pure.
  useEffect(() => {
    onEventRef.current = onEvent;
    onReconnectRef.current = onReconnect;
    onOpenRef.current = onOpen;
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

    es.onopen = () => {
      attemptsRef.current = 0;
      onOpenRef.current?.();
      if (droppedRef.current) {
        droppedRef.current = false;
        onReconnectRef.current?.();
      }
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
      droppedRef.current = true;
      if (!enabled) return;
      attemptsRef.current += 1;
      if (attemptsRef.current > MAX_RECONNECT_ATTEMPTS) return;
      const delay = Math.min(
        BASE_RECONNECT_MS * 2 ** (attemptsRef.current - 1),
        MAX_RECONNECT_MS,
      );
      reconnectTimerRef.current = setTimeout(() => {
        if (document.hidden) {
          // Don't reconnect (and replay-burst the backend) for a tab nobody
          // is looking at; resume when it becomes visible again.
          reconnectOnVisibleRef.current = true;
          return;
        }
        connect();
      }, delay);
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

    if (closeWhenHidden && document.hidden) {
      // Opened in a background tab: connect when first seen, and report that
      // open as a reconnect since the server-rendered page may be stale by then.
      droppedRef.current = true;
      reconnectOnVisibleRef.current = true;
    } else {
      connect();
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (!closeWhenHidden) return;
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        if (eventSourceRef.current) {
          detachAndClose(eventSourceRef.current, handlerRef.current);
          eventSourceRef.current = null;
        }
        droppedRef.current = true;
        reconnectOnVisibleRef.current = true;
        return;
      }
      // Revive a dead stream whenever the tab becomes visible again — both
      // the deferred-reconnect case and the gave-up-after-max-attempts case
      // (a long-hidden or slept tab exhausts the backoff budget; the user
      // coming back is the signal to try again from a clean slate).
      if (reconnectOnVisibleRef.current || eventSourceRef.current === null) {
        reconnectOnVisibleRef.current = false;
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        attemptsRef.current = 0;
        connect();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      reconnectOnVisibleRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (eventSourceRef.current) {
        detachAndClose(eventSourceRef.current, handlerRef.current);
        eventSourceRef.current = null;
      }
    };
  }, [enabled, connect, closeWhenHidden]);
}

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
  for (const eventType of EVENT_TYPES) {
    es.removeEventListener(eventType, handler);
  }
  es.close();
}
