"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { useRunEvents, type RunEvent } from "@/hooks/use-run-events";
import type { AgentTaskBatchRunSummary } from "@/lib/agent-task-api";
import { isBatchRunLive } from "@/lib/run-liveness";

/**
 * Coalesce SSE-triggered refreshes: a busy batch emits bursts (concurrent
 * task completions, plus one replayed `task_run.started` per running task on
 * every stream (re)connect), and each refresh re-runs the whole server page.
 */
const REFRESH_COALESCE_MS = 1000;

const BATCH_TERMINAL_EVENTS = new Set(["batch_run.completed", "batch_run.failed"]);
const TASK_PROGRESS_EVENTS = new Set([
  "task_run.started",
  "task_run.completed",
  "task_run.error",
]);

const isPending = (b: AgentTaskBatchRunSummary): boolean => isBatchRunLive(b.status);

interface RunsListAutoRefreshProps {
  project: string;
  batchRuns: AgentTaskBatchRunSummary[];
  /**
   * Listen for runs that are not listed yet. The list is newest-first, so a
   * run started elsewhere (CLI, schedule, another tab) only lands on page 0.
   */
  watchForNewRuns: boolean;
  /**
   * Listed running batches that had a task start, once per coalesce window.
   * That changes nothing the list shows, but an expanded row's task runs.
   */
  onTasksStarted?: (batchRunIds: string[]) => void;
}

export function RunsListAutoRefresh({
  project,
  batchRuns,
  watchForNewRuns,
  onTasksStarted,
}: RunsListAutoRefreshProps) {
  const router = useRouter();
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshPendingRef = useRef(false);
  const startedPendingRef = useRef(new Set<string>());
  const onTasksStartedRef = useRef(onTasksStarted);
  useEffect(() => {
    onTasksStartedRef.current = onTasksStarted;
  });
  // Unlisted batches already refreshed for once. One that is still unlisted
  // after that refresh is filtered out or on a later page, so its remaining
  // task events must not keep re-fetching a list it will never appear in.
  const refreshedForUnlistedRef = useRef(new Set<string>());

  const listedStatus = useMemo(
    () => new Map(batchRuns.map((b) => [b.id, b.status])),
    [batchRuns],
  );
  const hasPending = batchRuns.some(isPending);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, []);

  const scheduleFlush = useCallback(() => {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      if (refreshPendingRef.current) {
        refreshPendingRef.current = false;
        router.refresh();
      }
      const started = startedPendingRef.current;
      if (started.size > 0) {
        startedPendingRef.current = new Set();
        onTasksStartedRef.current?.([...started]);
      }
    }, REFRESH_COALESCE_MS);
  }, [router]);

  const scheduleRefresh = useCallback(() => {
    refreshPendingRef.current = true;
    scheduleFlush();
  }, [scheduleFlush]);

  const handleEvent = useCallback(
    (event: RunEvent) => {
      const isTerminal = BATCH_TERMINAL_EVENTS.has(event.event_type);
      if (!isTerminal && !TASK_PROGRESS_EVENTS.has(event.event_type)) return;
      const batchRunId = event.data.batch_run_id;
      if (typeof batchRunId !== "string" || !batchRunId) return;

      const listed = listedStatus.get(batchRunId);
      if (listed !== undefined) {
        // A task starting changes nothing a running row shows, and the backend
        // replays one `task_run.started` per running task on every connect.
        // It only re-renders the list for a queued row, which it moves to
        // running; otherwise it just tells the row its task runs moved on.
        if (event.event_type === "task_run.started" && listed !== "queued") {
          startedPendingRef.current.add(batchRunId);
          scheduleFlush();
          return;
        }
        scheduleRefresh();
        return;
      }
      if (!watchForNewRuns) return;
      // A terminal event always gets its refresh: a run hidden while running
      // (e.g. a status filter for failed runs) may match the list once it ends.
      const seen = refreshedForUnlistedRef.current;
      if (isTerminal || !seen.has(batchRunId)) {
        seen.add(batchRunId);
        scheduleRefresh();
      }
    },
    [listedStatus, watchForNewRuns, scheduleRefresh, scheduleFlush],
  );

  useRunEvents({
    project,
    enabled: hasPending || watchForNewRuns,
    onEvent: handleEvent,
    // Events published while the stream was down are never replayed.
    onReconnect: scheduleRefresh,
    closeWhenHidden: true,
  });

  return null;
}
