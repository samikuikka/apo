"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";

import { useRunEvents, type RunEvent } from "@/hooks/use-run-events";
import type { AgentTaskRunSummary } from "@/lib/agent-task-api";
import { isTaskRunLive } from "@/lib/run-liveness";

/** Same coalescing as the Runs list: a refresh re-runs the whole server page. */
const REFRESH_COALESCE_MS = 1000;

const TERMINAL_EVENTS = new Set(["task_run.completed", "task_run.error"]);

const isUnsettled = (run: AgentTaskRunSummary): boolean => isTaskRunLive(run.status);

/**
 * Re-renders the task page when one of this task's runs starts or ends.
 * The backend replays `task_run.started` for every running task on each
 * connect, so a start refreshes only for a run not listed as running, and
 * once per run (one still unlisted after that is filtered out). A terminal
 * event always refreshes: a finished run may now match a status filter.
 */
export function TaskRunsAutoRefresh({
  project,
  taskId,
  runs,
  watchForNewRuns,
}: {
  project: string;
  taskId: string;
  runs: AgentTaskRunSummary[];
  /** The task can get new runs (it is in the catalog). */
  watchForNewRuns: boolean;
}) {
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshedForStartRef = useRef(new Set<string>());

  const runningIds = useMemo(
    () => new Set(runs.filter((r) => r.status === "running").map((r) => r.id)),
    [runs],
  );
  const hasUnsettled = runs.some(isUnsettled);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      router.refresh();
    }, REFRESH_COALESCE_MS);
  }, [router]);

  const handleEvent = useCallback(
    (event: RunEvent) => {
      if (event.data.task_id !== taskId) return;
      if (TERMINAL_EVENTS.has(event.event_type)) {
        scheduleRefresh();
        return;
      }
      if (event.event_type !== "task_run.started") return;
      const runId = event.data.task_run_id;
      if (typeof runId !== "string" || runningIds.has(runId)) return;
      const seen = refreshedForStartRef.current;
      if (seen.has(runId)) return;
      seen.add(runId);
      scheduleRefresh();
    },
    [taskId, runningIds, scheduleRefresh],
  );

  useRunEvents({
    project,
    enabled: watchForNewRuns || hasUnsettled,
    onEvent: handleEvent,
    // A run that ended between the server render and this open sent its
    // terminal event to nobody, and the connect replay omits finished runs.
    onOpen: () => {
      if (hasUnsettled) scheduleRefresh();
    },
    // Events published while the stream was down are never replayed.
    onReconnect: scheduleRefresh,
    closeWhenHidden: true,
  });

  return null;
}
