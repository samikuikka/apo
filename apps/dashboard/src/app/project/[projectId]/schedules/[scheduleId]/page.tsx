import {
  getAgentTaskSchedule,
  getAdaptiveStates,
  listProjectAgentTasks,
  type AgentTaskSummary,
} from "@/lib/agent-task-api";
import type { Metadata } from "next";
import { ScheduleDetailClient } from "./schedule-detail-client";

export const dynamic = "force-dynamic";

// Tab title: "Schedule: <name>". Falls back to "Schedule" on fetch failure.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string; scheduleId: string }>;
}): Promise<Metadata> {
  const { scheduleId } = await params;
  try {
    const schedule = await getAgentTaskSchedule(scheduleId);
    return { title: `Schedule: ${schedule.name}` };
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
  const [adaptiveStates, taskInventory] = await Promise.all([
    getAdaptiveStates(scheduleId).catch(() => [] as Awaited<ReturnType<typeof getAdaptiveStates>>),
    listProjectAgentTasks(projectId).catch(() => [] as AgentTaskSummary[]),
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
    />
  );
}
