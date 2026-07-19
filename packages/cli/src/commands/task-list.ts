import { parseArgs } from "../lib/args.ts";
import { apiGet, isBackendReachable } from "../lib/api.ts";
import type { AgentTaskSummary } from "../lib/agent-task-types.ts";
import { resolveConfig } from "../lib/config.ts";
import { dim, formatJson, formatTable } from "../lib/format.ts";
import { discoverTaskMeta, type TaskMeta } from "../lib/task-meta.ts";

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  const tasks = config.projectId && await isBackendReachable(config.backendUrl)
    ? await apiGet<AgentTaskSummary[]>(
      config.backendUrl,
      `/v1/projects/${encodeURIComponent(config.projectId)}/agent-tasks`,
      undefined,
      config,
    )
    : discoverTaskMeta(config.taskRoot);

  if (config.json) {
    console.log(
      formatJson({
        tasks: tasks.map(taskToJson),
      }),
    );
    return 0;
  }

  if (tasks.length === 0) {
    console.log(dim("No tasks found"));
    return 0;
  }

  const rows = tasks.map((t) => isRemoteTask(t)
    ? [
      t.id,
      t.adapter_name,
      t.has_checks ? "yes" : "-",
      t.has_user_simulator ? "yes" : "-",
    ]
    : [
      t.id,
      t.adapter,
      t.hasChecks ? "yes" : "-",
      t.hasSimulator ? "yes" : "-",
    ]);
  console.log(
    formatTable(["ID", "Adapter", "Checks", "Simulator"], rows),
  );
  console.log("");
  console.log(dim(`${tasks.length} task${tasks.length === 1 ? "" : "s"} found`));

  return 0;
}

function taskToJson(t: TaskMeta | AgentTaskSummary): Record<string, unknown> {
  if (isRemoteTask(t)) {
    return t;
  }

  return {
    id: t.id,
    adapter: t.adapter,
    hasChecks: t.hasChecks,
    hasSimulator: t.hasSimulator,
    path: t.path,
    deliverables: t.deliverables,
  };
}

function isRemoteTask(task: TaskMeta | AgentTaskSummary): task is AgentTaskSummary {
  return "adapter_name" in task;
}
