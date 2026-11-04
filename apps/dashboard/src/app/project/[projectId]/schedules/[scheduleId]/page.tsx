import {
  getAgentTaskSchedule,
  getAdaptiveStates,
  listProjectAgentTasks,
  type AgentTaskSummary,
} from "@/lib/agent-task-api";
import type { Metadata } from "next";
import { detailTitle } from "@/lib/page-title";
import { ScheduleDetailClient } from "./schedule-detail-client";
import { listExecutorPools } from "@/lib/executor-api";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string; scheduleId: string }>;
}): Promise<Metadata> {
  const { scheduleId } = await params;
  try {
    const schedule = await getAgentTaskSchedule(scheduleId);
    return { title: detailTitle(schedule.name, "Schedule") };
  } catch {
    return { title: "Schedule" };
  }
}

export default async function ScheduleDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; scheduleId: string }>;
}) {
  const { projectId, scheduleId } = await params;

  let schedule: Awaited<ReturnType<typeof getAgentTaskSchedule>> | undefined;
  let error: string | null = null;

  try {
    schedule = await getAgentTaskSchedule(scheduleId);
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to fetch schedule";
  }

  if (error) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
          <p className="font-medium">Error</p>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!schedule) return null;

  // Non-critical data — degrade gracefully if these fail
  const [adaptiveStates, taskInventory, executorPools] = await Promise.all([
    getAdaptiveStates(scheduleId).catch(() => [] as Awaited<ReturnType<typeof getAdaptiveStates>>),
    listProjectAgentTasks(projectId).catch(() => [] as AgentTaskSummary[]),
    listExecutorPools(projectId).catch(() => []),
  ]);

  const taskNames = new Map<string, AgentTaskSummary>();
  for (const t of taskInventory) {
    taskNames.set(t.id, t);
  }

  return (
    <ScheduleDetailClient
      projectId={projectId}
      schedule={schedule}
      adaptiveStates={adaptiveStates}
      taskNames={taskNames}
      executorPools={executorPools}
    />
  );
}
