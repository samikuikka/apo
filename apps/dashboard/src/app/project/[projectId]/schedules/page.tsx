import {
  listAgentTaskSchedules,
  listProjectAgentTasks,
} from "@/lib/agent-task-api";
import { getProject, type ProjectTaskSource } from "@/lib/projects-api";
import { listExecutorPools } from "@/lib/executor-api";
import { AgentTaskSchedulesClient } from "./schedules-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Schedules" };

const EMPTY_TASKS: Awaited<ReturnType<typeof listProjectAgentTasks>> = [];
const EMPTY_SCHEDULES: Awaited<ReturnType<typeof listAgentTaskSchedules>> = [];
const EMPTY_EXECUTOR_POOLS: Awaited<ReturnType<typeof listExecutorPools>> = [];

export default async function AgentTaskSchedulesPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ taskIds?: string }>;
}) {
  const [{ projectId }, { taskIds }] = await Promise.all([params, searchParams]);

  let tasks = EMPTY_TASKS;
  let schedules = EMPTY_SCHEDULES;
  let error: string | null = null;
  let taskSource: ProjectTaskSource | null = null;
  let executorPools: Awaited<ReturnType<typeof listExecutorPools>> = EMPTY_EXECUTOR_POOLS;

  let canManage = false;
  try {
    [schedules, taskSource, executorPools] = await Promise.all([
      listAgentTaskSchedules(projectId),
      getProject(projectId)
        .then((project) => project.task_source)
        .catch(() => null),
      listExecutorPools(projectId),
    ]);

    // The task list always comes from the project's configured source
    // inventory — demo included (it is provisioned with a bundled `demo`
    // source at startup). Projects without a source get an inline hint in
    // the schedules client instead of a task picker.
    if (taskSource && !taskSource.inventory_stale) {
      tasks = await listProjectAgentTasks(projectId);
    }
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to load schedules";
  }
  // Schedule management is admin-tier; viewers (and the anonymous demo
  // visitor) never see the controls at all. Resolved after
  // the data loads so a failed project fetch keeps the affordances off.
  canManage = await getProject(projectId)
    .then((project) => project.permissions?.can_manage_project === true)
    .catch(() => false);

  const initialTaskIds = taskIds
    ? taskIds
        .split(",")
        .flatMap((value) => { const trimmed = value.trim(); return trimmed ? [trimmed] : []; })
    : [];

  return (
    <AgentTaskSchedulesClient
      tasks={tasks}
      schedules={schedules}
      initialTaskIds={initialTaskIds}
      error={error}
      taskSource={taskSource}
      executorPools={executorPools}
      canManage={canManage}
    />
  );
}
