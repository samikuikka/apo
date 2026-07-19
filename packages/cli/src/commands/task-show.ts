import { parseArgs, requirePositional } from "../lib/args.ts";
import { apiGet, isBackendReachable } from "../lib/api.ts";
import type { AgentTaskDetail } from "../lib/agent-task-types.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatJson } from "../lib/format.ts";
import { findTaskMetaById, type TaskMeta } from "../lib/task-meta.ts";

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const taskId = requirePositional(positional, 0, "task-id");

  const task = config.projectId && await isBackendReachable(config.backendUrl)
    ? await apiGet<AgentTaskDetail>(
      config.backendUrl,
      `/v1/projects/${encodeURIComponent(config.projectId)}/agent-tasks/${encodeURIComponent(taskId)}`,
      undefined,
      config,
    )
    : findTaskMetaById(config.taskRoot, taskId);

  if (!task) {
    console.error(`Task not found: ${taskId}`);
    return 2;
  }

  if (config.json) {
    console.log(formatJson(task));
    return 0;
  }

  console.log(bold(`Task: ${task.id}`));
  if (isRemoteTask(task)) {
    console.log(`  Adapter:     ${task.adapter_name}`);
    console.log(`  Checks:      ${task.has_checks ? "yes" : "no"}`);
    console.log(`  Simulator:   ${task.has_user_simulator ? "yes" : "no"}`);
    console.log(`  Path:        ${task.task_path}`);
    console.log(`  Folder:      ${task.folder_path}`);
    if (task.tags.length > 0) {
      console.log(`  Tags:        ${task.tags.join(", ")}`);
    }
    if (task.latest_run) {
      console.log(dim("  Latest run:"));
      console.log(dim(`    - ${task.latest_run.id}: ${task.latest_run.status}`));
    }
  } else {
    console.log(`  Adapter:     ${task.adapter}`);
    console.log(`  Checks:      ${task.hasChecks ? "yes" : "no"}`);
    console.log(`  Simulator:   ${task.hasSimulator ? "yes" : "no"}`);
    console.log(`  Path:        ${task.path}`);

    if (task.deliverables.length > 0) {
      console.log(`  Deliverables: ${task.deliverables.join(", ")}`);
    }

    if (task.files.length > 0) {
      console.log(dim("  Files:"));
      for (const f of task.files) {
        console.log(dim(`    - ${f}`));
      }
    }
  }

  return 0;
}

function isRemoteTask(task: TaskMeta | AgentTaskDetail): task is AgentTaskDetail {
  return "adapter_name" in task;
}
