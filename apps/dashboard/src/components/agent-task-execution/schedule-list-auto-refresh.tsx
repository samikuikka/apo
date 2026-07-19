"use client";

import { useMemo } from "react";
import { useRunEvents } from "@/hooks/use-run-events";
import type { AgentTaskScheduleSummary } from "@/lib/agent-task-api";

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
    if (batch.status !== "running" && batch.status !== "queued") continue;
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
  });

  return null;
}