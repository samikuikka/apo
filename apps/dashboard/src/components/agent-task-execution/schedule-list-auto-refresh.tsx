"use client";

import { useMemo } from "react";
import { useRunEvents } from "@/hooks/use-run-events";
import type { AgentTaskScheduleSummary } from "@/lib/agent-task-api";
import { isBatchRunLive } from "@/lib/run-liveness";

interface ScheduleListAutoRefreshProps {
  project: string;
  schedules: AgentTaskScheduleSummary[];
  onRefresh: (scheduleId: string) => void;
}

function collectPendingBatchRunIds(
  schedules: AgentTaskScheduleSummary[]
): { byBatchRunId: Map<string, Set<string>>; hasPending: boolean } {
  const byBatchRunId = new Map<string, Set<string>>();
  let hasPending = false;
  for (const s of schedules) {
    const batch = s.last_batch;
    if (!batch) continue;
    if (!isBatchRunLive(batch.status)) continue;
    hasPending = true;
    const ids = [s.last_batch_run_id, batch.id].filter(
      (v): v is string => typeof v === "string" && v.length > 0
    );
    for (const id of ids) {
      const set = byBatchRunId.get(id) ?? new Set<string>();
      set.add(s.id);
      byBatchRunId.set(id, set);
    }
  }
  return { byBatchRunId, hasPending };
}

export function ScheduleListAutoRefresh({
  project,
  schedules,
  onRefresh,
}: ScheduleListAutoRefreshProps) {
  const { byBatchRunId, hasPending } = useMemo(
    () => collectPendingBatchRunIds(schedules),
    [schedules]
  );

  useRunEvents({
    project,
    enabled: hasPending,
    onEvent: (event) => {
      if (
        event.event_type !== "batch_run.completed" &&
        event.event_type !== "batch_run.failed"
      )
        return;
      const batchRunId = String(
        (event.data as { batch_run_id?: unknown }).batch_run_id ?? ""
      );
      if (!batchRunId) return;
      const scheduleIds = byBatchRunId.get(batchRunId);
      if (!scheduleIds) return;
      for (const id of scheduleIds) onRefresh(id);
    },
    // A drop is a window a pending batch's terminal event may have fallen
    // into — it is never replayed, so re-fetch every pending schedule.
    onReconnect: () => {
      const ids = new Set<string>();
      for (const set of byBatchRunId.values()) {
        for (const id of set) ids.add(id);
      }
      for (const id of ids) onRefresh(id);
    },
  });

  return null;
}