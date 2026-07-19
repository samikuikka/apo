import { parseArgs, getFlagValue } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { dim, formatCost, formatJson, formatTable, formatTime } from "../lib/format.ts";
import { apiGet } from "../lib/api.ts";
import { highlightIds } from "../lib/prefix.ts";

type RunSummary = {
  id: string;
  task_id: string;
  batch_run_id: string;
  status: string;
  pass_result: boolean | null;
  started_at: string;
  completed_at: string | null;
  total_cost: number | null;
  total_checks: number;
  passed_checks: number;
  failed_checks: number;
  adapter_name: string;
};

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  const params: Record<string, string> = {};
  const taskId = getFlagValue(flags, "task");
  if (taskId) params.task_id = taskId;
  if (config.projectId) params.project = config.projectId;
  const status = getFlagValue(flags, "status");
  if (status) params.status = status;
  const limit = getFlagValue(flags, "limit");
  if (limit) params.limit = limit;

  let runs: RunSummary[];
  try {
    runs = await apiGet<RunSummary[]>(
      config.backendUrl,
      "/v1/agent-task-runs",
      params,
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
    console.log(formatJson(runs));
    return 0;
  }

  if (limit) {
    const n = parseInt(limit, 10);
    if (!Number.isNaN(n) && n > 0) {
      runs = runs.slice(0, n);
    }
  }

  if (runs.length === 0) {
    console.log(dim("No runs found"));
    return 0;
  }

  const idLabels = highlightIds(runs.map((r) => r.id));
  const rows = runs.map((r, i) => [
    idLabels[i],
    r.task_id,
    r.batch_run_id.slice(0, 8),
    r.status,
    r.pass_result === null ? "-" : r.pass_result ? "PASS" : "FAIL",
    formatCost(r.total_cost),
    formatTime(r.started_at),
  ]);
  console.log(
    formatTable(["Run ID", "Task", "Batch", "Status", "Result", "Cost", "Started"], rows),
  );
  console.log("");
  console.log(dim(`${runs.length} run${runs.length === 1 ? "" : "s"}`));

  return 0;
}
