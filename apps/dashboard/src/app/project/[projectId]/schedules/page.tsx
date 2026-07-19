import {
  listAgentTaskSchedules,
  listAgentTasks,
  listProjectAgentTasks,
} from "@/lib/agent-task-api";
import { getProject, type ProjectTaskSource } from "@/lib/projects-api";
import { AgentTaskSchedulesClient } from "./schedules-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Schedules" };

const TASK_ROOT = process.env.NEXT_PUBLIC_AGENT_TASK_ROOT ?? null;
const EMPTY_TASKS: Awaited<ReturnType<typeof listAgentTasks>> = [];
const EMPTY_SCHEDULES: Awaited<ReturnType<typeof listAgentTaskSchedules>> = [];

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

  try {
    [schedules, taskSource] = await Promise.all([
      listAgentTaskSchedules(projectId),
      getProject(projectId)
        .then((project) => project.task_source)
        .catch(() => null),
    ]);

    // SPEC-118: non-demo projects must NOT inherit example-service tasks
    // via the legacy DEFAULT_TASK_ROOT fallback. The task list comes
    // from the project's configured source (SPEC-119 inventory) or is
    // empty. Demo keeps legacy discovery (its source is seeded from the
    // bundled workspace).
    if (projectId === "demo") {
      tasks = await listAgentTasks(TASK_ROOT, undefined, projectId);
    } else if (taskSource && !taskSource.inventory_stale) {
      tasks = await listProjectAgentTasks(projectId);
    }
    // else: non-demo + no source → leave tasks empty. The schedules
    // client renders ProjectTaskSourceEmptyState in this case.
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to load schedules";
  }

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
      taskRoot={TASK_ROOT}
      error={error}
      taskSource={taskSource}
    />
  );
}
