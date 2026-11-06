import { parseArgs, getFlagValue, getFlagValues } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { dim, formatCost, formatJson, formatTable, formatTime, red } from "../lib/format.ts";
import { formatDuration } from "../lib/format.ts";
import { apiGet } from "../lib/api.ts";
import { highlightIds } from "../lib/prefix.ts";
import { reportCommandError } from "../lib/command-error.ts";
import { parseLabelRef } from "../lib/run-labels.ts";

type BatchSummary = {
  id: string;
  status: string;
  total_tasks: number;
  passed_tasks: number;
  failed_tasks: number;
  errored_tasks: number;
  total_cost: number | null;
  unpriced_call_count?: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export async function run(argv: string[]): Promise<number> {
  const { flags, multiFlags } = parseArgs(argv);
  const config = resolveConfig(flags);

  const params: Record<string, string | string[]> = {};
  if (config.projectId) params.project = config.projectId;
  const status = getFlagValue(flags, "status");
  if (status) params.status = status;
  // Batch targeting filters: environments OR, labels OR within a key and
  // AND across keys (the backend splits each raw key:id value itself).
  const environments = getFlagValues(multiFlags, "environment");
  if (environments.length > 0) params.environment = environments.join(",");
  const labels = getFlagValues(multiFlags, "label");
  for (const raw of labels) {
    try {
      parseLabelRef(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(red(`error: ${message}`));
      return 2;
    }
  }
  if (labels.length > 0) params.label = labels;

  let batches: BatchSummary[];
  try {
    // The backend returns a paginated payload ({data: [...], total_count, ...});
    // older deployments answered with a bare array. Accept both.
    const payload = await apiGet<BatchSummary[] | { data: BatchSummary[] }>(
      config.backendUrl,
      "/v1/agent-task-batch-runs",
      params,
      config,
    );
    batches = Array.isArray(payload) ? payload : payload.data;
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
  }

  if (config.json) {
    console.log(formatJson(batches));
    return 0;
  }

  if (batches.length === 0) {
    console.log(dim("No batch runs found"));
    return 0;
  }

  // Mirrors runs-list's partial-cost rule (issue #147): a batch whose runs
  // include unpriced calls must not read as a complete total.
  const formatBatchCost = (b: BatchSummary): string => {
    const cost = formatCost(b.total_cost);
    return (b.unpriced_call_count ?? 0) > 0 ? `${cost} ${dim("partial")}` : cost;
  };

  const idLabels = highlightIds(batches.map((b) => b.id));
  const rows = batches.map((b, i) => [
    idLabels[i],
    String(b.total_tasks),
    b.status,
    `${b.passed_tasks}/${b.total_tasks}`,
    formatBatchCost(b),
    formatDuration(b.started_at, b.completed_at),
    formatTime(b.created_at),
  ]);
  console.log(
    formatTable(
      ["Batch ID", "Tasks", "Status", "Passed", "Cost", "Duration", "Created"],
      rows,
    ),
  );
  console.log("");
  console.log(
    dim(`${batches.length} batch${batches.length === 1 ? "" : "es"}`),
  );

  return 0;
}
