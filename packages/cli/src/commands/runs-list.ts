import { getFlagValues, getFlagValue, parseArgs } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { dim, formatCost, formatJson, formatTable, formatTime } from "../lib/format.ts";
import { apiGet } from "../lib/api.ts";
import { highlightIds } from "../lib/prefix.ts";
import { reportCommandError } from "../lib/command-error.ts";
import { formatRunResult } from "../lib/checks-format.ts";

type RunConfiguration = { model: string; effort?: string | null } | null;

type RunSummary = {
  id: string;
  task_id: string;
  batch_run_id: string;
  status: string;
  pass_result: boolean | null;
  started_at: string;
  completed_at: string | null;
  total_cost: number | null;
  unpriced_call_count?: number;
  total_checks: number;
  passed_checks: number;
  failed_checks: number;
  errored_checks?: number;
  error_message?: string | null;
  no_verdict_reason?: "judge" | "generations" | "executor" | null;
  adapter_name: string;
  run_configuration?: RunConfiguration;
  /** (model, provider/route) pairs the run's trace served through
   * (issue #307). Empty when no call reported a host. */
  model_providers?: ModelProviderPair[];
  generation_execution?: {
    total: number;
    errored: number;
    error_finish_reasons: Record<string, number>;
  } | null;
};

type ModelProviderPair = {
  model: string;
  provider: string | null;
  route: string | null;
  calls: number;
  total_tokens: number | null;
  cost_micro: number | null;
};

function formatExecution(cfg: RunConfiguration | undefined): string {
  if (!cfg) return dim("-");
  const effort = cfg.effort && cfg.effort !== "" ? cfg.effort : dim("—");
  return `${cfg.model} · ${effort}`;
}

export async function run(argv: string[]): Promise<number> {
  const { flags, multiFlags } = parseArgs(argv);
  const config = resolveConfig(flags);

  const params: Record<string, string | string[]> = {};
  const taskId = getFlagValue(flags, "task");
  if (taskId) params.task_id = taskId;
  if (config.projectId) params.project = config.projectId;
  const status = getFlagValue(flags, "status");
  if (status) params.status = status;
  const limit = getFlagValue(flags, "limit");
  if (limit) params.limit = limit;
  // repeatable model/effort filters (OR within dimension, AND across).
  const models = getFlagValues(multiFlags, "model");
  if (models.length > 0) params.model = models;
  const efforts = getFlagValues(multiFlags, "effort");
  if (efforts.length > 0) params.effort = efforts;
  // Serving-host filter: matches the observed provider or route on the
  // run's trace calls, so "openrouter:nitro" finds routed runs (issue #307).
  const providers = getFlagValues(multiFlags, "provider");
  if (providers.length > 0) params.provider = providers;

  let runs: RunSummary[];
  try {
    runs = await apiGet<RunSummary[]>(
      config.backendUrl,
      "/v1/agent-task-runs",
      params,
      config,
    );
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
  }

  // The backend ignores the limit query param on this endpoint, so enforce
  // it client-side — for JSON output too, not just the table.
  if (limit) {
    const n = parseInt(limit, 10);
    if (!Number.isNaN(n) && n > 0) {
      runs = runs.slice(0, n);
    }
  }

  if (config.json) {
    console.log(formatJson(runs));
    return 0;
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
    formatRunResult(r),
    formatGenerationExecution(r.generation_execution),
    formatExecution(r.run_configuration),
    formatHosts(r.model_providers),
    formatRunCost(r),
    formatTime(r.started_at),
  ]);
  console.log(
    formatTable(
      ["Run ID", "Task", "Batch", "Status", "Result", "Generations", "Execution", "Hosts", "Cost", "Started"],
      rows,
    ),
  );
  console.log("");
  console.log(dim(`${runs.length} run${runs.length === 1 ? "" : "s"}`));

  return 0;
}

function formatGenerationExecution(
  execution: RunSummary["generation_execution"],
): string {
  if (!execution || execution.errored <= 0) return dim("-");
  return `${execution.errored}/${execution.total} error`;
}

/** Distinct serving-host labels (route wins over provider) for the Hosts
 * column (issue #307); dim dash when no call reported a host. Capped so a
 * run with several long route strings (fallback chains embed hostnames)
 * can't blow up the table — `runs show` carries the full pairs. */
function formatHosts(pairs: ModelProviderPair[] | undefined): string {
  if (!pairs || pairs.length === 0) return dim("-");
  const labels = [
    ...new Set(pairs.map((p) => p.route || p.provider).filter((l): l is string => !!l)),
  ];
  if (labels.length === 0) return dim("-");
  const shown = labels.slice(0, 2).map((l) =>
    l.length > 24 ? `${l.slice(0, 23)}…` : l
  );
  const more = labels.length - shown.length;
  return more > 0 ? `${shown.join(" · ")} ${dim(`+${more}`)}` : shown.join(" · ");
}

function formatRunCost(run: RunSummary): string {
  const cost = formatCost(run.total_cost);
  const partial =
    (run.generation_execution?.errored ?? 0) > 0 ||
    (run.unpriced_call_count ?? 0) > 0;
  return partial ? `${cost} ${dim("partial")}` : cost;
}
