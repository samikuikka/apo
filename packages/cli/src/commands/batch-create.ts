import { hostname } from "os";
import { resolve } from "path";
import { parseArgs, getFlagValue } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatJson } from "../lib/format.ts";
import { apiPost } from "../lib/api.ts";
import { discoverTaskMeta, resolveTaskRef } from "../lib/task-meta.ts";

type TaskRunSummary = {
  id: string;
  task_id: string;
  status: string;
  pass_result: boolean | null;
};

type BatchDetail = {
  id: string;
  status: string;
  total_tasks: number;
  task_runs: TaskRunSummary[];
};

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  const taskIds = getFlagValue(flags, "tasks");
  if (!taskIds) {
    console.error("Missing required flag: --tasks <id1,id2,...>");
    return 2;
  }

  const requestedIds = taskIds.split(",").map((s) => s.trim()).filter(Boolean);
  if (requestedIds.length === 0) {
    console.error("No task IDs provided");
    return 2;
  }

  let taskSelections = requestedIds;
  if (!config.projectId) {
    const tasks = discoverTaskMeta(config.taskRoot);
    // Resolve each requested ref against the discovered tree so bare names
    // resolve when unique and folder-scoped ids match exactly (issue #12).
    const resolved = requestedIds.map((id) => resolveTaskRef(tasks, id));
    const missingIds = requestedIds.filter((_, i) => !resolved[i]);

    if (missingIds.length > 0) {
      console.error(`Tasks not found: ${missingIds.join(", ")}`);
      return 2;
    }

    taskSelections = resolved.map((t) => t!.path);
  }

  const body: Record<string, unknown> = {
    selection_type: "tasks",
    task_paths: taskSelections,
    task_root: resolve(config.taskRoot),
    run_metadata: {
      trigger: {
        source: "cli",
        actor: config.actor ?? process.env.USER ?? process.env.LOGNAME ?? null,
        hostname: hostname(),
        entrypoint: "apo batch create",
        initiated_at: new Date().toISOString(),
      },
    },
  };
  if (config.projectId) {
    body.project = config.projectId;
  }

  let batch: BatchDetail;
  try {
    batch = await apiPost<BatchDetail>(
      config.backendUrl,
      "/v1/agent-task-batch-runs",
      body,
      config,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Backend error")) {
      console.error(message);
    } else {
      console.error(`Cannot connect to backend at ${config.backendUrl}`);
      console.error(dim(message));
    }
    return 2;
  }

  if (config.json) {
    console.log(formatJson(batch));
    return 0;
  }

  console.log(bold(`Batch created: ${batch.id}`));
  console.log(`  Status: ${batch.status}`);
  console.log(`  Tasks:  ${batch.total_tasks}`);

  if (batch.task_runs.length > 0) {
    console.log(dim("  Runs:"));
    for (const tr of batch.task_runs) {
      console.log(dim(`    - ${tr.task_id}: ${tr.status}`));
    }
  }

  return 0;
}
