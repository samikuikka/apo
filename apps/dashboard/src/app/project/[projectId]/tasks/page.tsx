import {
  listAgentTasks,
  listProjectAgentTasks,
} from "@/lib/agent-task-api";
import { getProject } from "@/lib/projects-api";
import { DEMO_PROJECT } from "@/lib/project-router";
import { AgentTasksClient } from "./tasks-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Tasks" };

const TASK_ROOT = process.env.NEXT_PUBLIC_AGENT_TASK_ROOT ?? null;

export default async function AgentTasksPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const isDemo = projectId === DEMO_PROJECT;

  let tasks: Awaited<ReturnType<typeof listAgentTasks>> = [];
  let error: string | null = null;
  let taskSource = null;

    try {
      // Fetch the project so we can branch on task source presence.
      // Access (403) and existence (404) are enforced by the project layout,
      // so this only surfaces transient/network failures as inline errors.
      try {
        const project = await getProject(projectId);
        taskSource = project.task_source;
      } catch (e: unknown) {
        error = e instanceof Error ? e.message : "Failed to load project";
      }

    // SPEC-118: non-demo projects must NOT inherit example-service tasks
    // via the legacy DEFAULT_TASK_ROOT fallback. The task list comes from
    // either the project's configured source (SPEC-119 inventory) or is
    // empty — which surfaces the setup card on the client.
    //
    // The demo project keeps the legacy discovery path because its source
    // is seeded from the bundled example-service workspace and reading
    // from inventory happens automatically once demo is seeded.
    if (!isDemo && taskSource !== null && !taskSource.inventory_stale) {
      try {
        tasks = await listProjectAgentTasks(projectId);
      } catch (e: unknown) {
        error = e instanceof Error ? e.message : "Failed to fetch agent tasks";
      }
    } else if (isDemo) {
      tasks = await listAgentTasks(TASK_ROOT, undefined, projectId);
    }
    // else: non-demo + no source → leave tasks empty so the setup card
    // renders instead of leaking example-service tasks.
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to fetch agent tasks";
  }

  return (
    <AgentTasksClient
      tasks={tasks}
      error={error}
      taskSource={taskSource}
      isDemo={isDemo}
    />
  );
}
