import { existsSync } from "fs";
import { parseArgs, getBoolFlag, requirePositional } from "../lib/args.ts";
import { apiGet, isBackendReachable } from "../lib/api.ts";
import type { AgentTaskDetail } from "../lib/agent-task-types.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatJson } from "../lib/format.ts";
import { findTaskMetaById, type TaskMeta } from "../lib/task-meta.ts";

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const taskId = requirePositional(positional, 0, "task-id");

  // Same universe rule as `task list`: the task root your login captured is
  // the default; the backend catalog is the explicit --catalog view (or the
  // fallback when no local task root exists).
  const explicitDir =
    typeof config._rawFlags["dir"] === "string" || !!process.env.APO_TASK_ROOT;
  const catalogFlag = getBoolFlag(flags, "catalog");
  const rootExists = existsSync(config.taskRoot);

  let useCatalog: boolean;
  if (catalogFlag) {
    if (!config.projectId) {
      console.error("--catalog requires a project (run: apo project use).");
      return 2;
    }
    useCatalog = true;
  } else if (explicitDir || rootExists) {
    useCatalog = false;
  } else {
    useCatalog = !!config.projectId && await isBackendReachable(config.backendUrl);
  }

  if (!useCatalog && !rootExists) {
    console.error(`Task root not found: ${config.taskRoot}`);
    console.error("Set --dir <path> or APO_TASK_ROOT, or re-run `apo login` from your task repository.");
    return 2;
  }

  const task = useCatalog
    ? await fetchCatalogTask(config, taskId)
    : findTaskMetaById(config.taskRoot, taskId);

  if (!task) {
    const universe = useCatalog
      ? `the backend catalog (project ${config.projectId})`
      : config.taskRoot;
    console.error(`Task not found in ${universe}: ${taskId}`);
    return 2;
  }

  if (config.json) {
    console.log(formatJson(task));
    return 0;
  }

  console.log(bold(`Task: ${task.id}`));
  if (isRemoteTask(task)) {
    console.log(`  Name:        ${task.display_name}`);
    if (task.description) {
      console.log(`  Description: ${task.description}`);
    }
    console.log(`  Adapter:     ${task.adapter_name}`);
    console.log(`  Checks:      ${task.has_checks ? "yes" : "no"}`);
    console.log(`  Path:        ${task.task_path}`);
    console.log(`  Folder:      ${task.folder_path}`);
    if (task.tags.length > 0) {
      console.log(`  Tags:        ${task.tags.join(", ")}`);
    }
    if (task.run_stats && task.run_stats.total_runs > 0) {
      const stats = task.run_stats;
      const avg = stats.avg_duration_ms != null ? ` · avg ${(stats.avg_duration_ms / 1000).toFixed(1)}s` : "";
      console.log(`  Runs:        ${stats.total_runs} total · ${stats.passed_runs} passed · ${stats.failed_runs} failed · ${stats.errored_runs} errored (${Math.round(stats.pass_rate * 100)}% pass)${avg}`);
    }
    if (task.run_stats?.not_started_runs) {
      console.log(dim(`  Not started: ${task.run_stats.not_started_runs} (ended before an executor started them)`));
    }
    if (task.latest_run) {
      console.log(dim(`  Latest run:  ${task.latest_run.id} — ${task.latest_run.status}`));
    }
  } else {
    console.log(`  Adapter:     ${task.adapter}`);
    if (task.description) {
      console.log(`  Description: ${task.description}`);
    }
    console.log(`  Checks:      ${task.hasChecks ? "yes" : "no"}`);
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
  console.log(dim(`  Notes:       apo notes list ${task.id}`));

  return 0;
}

function isRemoteTask(task: TaskMeta | AgentTaskDetail): task is AgentTaskDetail {
  return "adapter_name" in task;
}

async function fetchCatalogTask(
  config: ReturnType<typeof resolveConfig>,
  taskId: string,
): Promise<AgentTaskDetail | null> {
  try {
    return await apiGet<AgentTaskDetail>(
      config.backendUrl,
      `/v1/projects/${encodeURIComponent(config.projectId!)}/agent-tasks/${encodeURIComponent(taskId)}`,
      undefined,
      config,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404")) {
      return null;
    }
    throw error;
  }
}
