"use client";

import { useRouter } from "next/navigation";
import { useRunEvents, RunEvent } from "@/hooks/use-run-events";

interface TaskRunAutoRefreshProps {
  project: string;
  taskRunId: string;
  isRunning: boolean;
}

export function TaskRunAutoRefresh({
  project,
  taskRunId,
  isRunning,
}: TaskRunAutoRefreshProps) {
  const router = useRouter();

  const handleEvent = (event: RunEvent) => {
    if (
      (event.event_type === "task_run.completed" ||
        event.event_type === "task_run.error") &&
      event.data.task_run_id === taskRunId
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
