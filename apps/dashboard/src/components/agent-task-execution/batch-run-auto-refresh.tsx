"use client";

import { useRouter } from "next/navigation";
import { useRunEvents, RunEvent } from "@/hooks/use-run-events";

interface BatchRunAutoRefreshProps {
  project: string;
  batchRunId: string;
  isRunning: boolean;
}

export function BatchRunAutoRefresh({
  project,
  batchRunId,
  isRunning,
}: BatchRunAutoRefreshProps) {
  const router = useRouter();

  const handleEvent = (event: RunEvent) => {
    if (event.data.batch_run_id !== batchRunId) return;

    // Refresh on any task or batch event for this batch run. The
    // trace_claimed event fires mid-run when ingestion first links a trace
    // to a task run — without it the live-trace panel never opens while the
    // task is executing (it would stay stuck on "Waiting for spans...").
    if (
      event.event_type === "batch_run.completed" ||
      event.event_type === "batch_run.failed" ||
      event.event_type === "task_run.started" ||
      event.event_type === "task_run.completed" ||
      event.event_type === "task_run.error" ||
      event.event_type === "task_run.trace_claimed"
    ) {
      router.refresh();
    }
  };

  useRunEvents({
    project,
    enabled: isRunning,
    onEvent: handleEvent,
  });

  return null;
}
