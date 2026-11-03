"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";

import { useRunEvents, type RunEvent } from "@/hooks/use-run-events";
import type { AgentTaskRunSummary } from "@/lib/agent-task-api";

/** Same coalescing as the Runs list: a refresh re-runs the whole server page. */
const REFRESH_COALESCE_MS = 1000;

const TERMINAL_EVENTS = new Set(["task_run.completed", "task_run.error"]);

/**
 * Re-renders the task page when one of this task's runs starts or ends, so a
 * run launched from the CLI or another tab shows up without a reload.
 *
 * The backend replays one `task_run.started` per running task on every stream
 * connect, so a start only refreshes for a run not already listed as running,
 * and only once per run: one still unlisted after that refresh is hidden by
 * the scope filters or beyond the fetch bound. A terminal event always
 * refreshes, since a finished run may now match a status filter.
 */
export function TaskRunsAutoRefresh({
  project,
  taskId,
  runs,
}: {
  project: string;
  taskId: string;
  runs: AgentTaskRunSummary[];
}) {
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshedForStartRef = useRef(new Set<string>());

  const runningIds = useMemo(
    () => new Set(runs.filter((r) => r.status === "running").map((r) => r.id)),
    [runs],
  );

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
    enabled: true,
    onEvent: handleEvent,
    // Events published while the stream was down are never replayed.
    onReconnect: scheduleRefresh,
    closeWhenHidden: true,
  });

  return null;
}
