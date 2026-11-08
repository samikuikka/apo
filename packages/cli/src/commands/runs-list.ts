import { getFlagValues, getFlagValue, parseArgs } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { dim, formatCost, formatJson, formatTable, formatTime, red } from "../lib/format.ts";
import { apiGet } from "../lib/api.ts";
import { highlightIds } from "../lib/prefix.ts";
import { reportCommandError } from "../lib/command-error.ts";
import { formatRunResult } from "../lib/checks-format.ts";
import { parseLabelRef } from "../lib/run-labels.ts";
import type { ServingIdentity, ServingSummary } from "../lib/serving-types.ts";

type RunConfiguration = { model: string; effort?: string | null } | null;

type RunSummary = {
  id: string;
  task_id: string;
  batch_run_id: string;
  status: string;
  pass_result: boolean | null;
  started_at: string | null;
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
  /** Observed serving summary (issue #307). Null when the backend built
   * the item without trace access; `no_data` when the trace has no
   * generations. */
  serving?: ServingSummary | null;
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
  // When any serving dimension below is present, the backend folds these
  // values into the same-request serving predicate instead.
  const providers = getFlagValues(multiFlags, "provider");
  if (providers.length > 0) params.provider = providers;
  // Same-request serving filters (issue #307): repeated values OR within a
  // dimension, dimensions AND on one request. The backend splits
  // comma-joined values itself; the unknown operator and mode are validated
  // here so a typo fails fast with a CLI error instead of a backend 422.
  const observedModels = getFlagValues(multiFlags, "observed-model");
  if (observedModels.length > 0) params.observed_model = observedModels;
  const hosts = getFlagValues(multiFlags, "host");
  if (hosts.length > 0) params.host = hosts;
  const routes = getFlagValues(multiFlags, "route");
  if (routes.length > 0) params.route = routes;
  const serviceTiers = getFlagValues(multiFlags, "service-tier");
  if (serviceTiers.length > 0) params.service_tier = serviceTiers;
  const unknownDimensions = splitCommaJoined(getFlagValues(multiFlags, "serving-unknown"));
  for (const dimension of unknownDimensions) {
    if (!SERVING_UNKNOWN_DIMENSIONS.includes(dimension)) {
      console.error(
        red(
          `error: --serving-unknown must be one of ${SERVING_UNKNOWN_DIMENSIONS.join(", ")} (got '${dimension}')`,
        ),
      );
      return 2;
    }
  }
  if (unknownDimensions.length > 0) params.serving_unknown = unknownDimensions;
  const servingMode = getFlagValue(flags, "serving-mode");
  if (servingMode) {
    if (servingMode !== "contains" && servingMode !== "only") {
      console.error(
        red(`error: --serving-mode must be contains or only (got '${servingMode}')`),
      );
      return 2;
    }
    params.serving_mode = servingMode;
  }
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
  // The Serving column appears only when the backend attached serving
  // summaries, so responses without it keep the old width.
  const showServing = runs.some((r) => r.serving != null);
  const rows = runs.map((r, i) => {
    const row = [
      idLabels[i],
      r.task_id,
      r.batch_run_id.slice(0, 8),
      r.status,
      formatRunResult(r),
      formatGenerationExecution(r.generation_execution),
      formatExecution(r.run_configuration),
      formatHosts(r.model_providers),
    ];
    if (showServing) row.push(formatServingCell(r.serving));
    row.push(formatRunCost(r), formatTime(r.started_at));
    return row;
  });
  const headers = [
    "Run ID",
    "Task",
    "Batch",
    "Status",
    "Result",
    "Generations",
    "Execution",
    "Hosts",
    ...(showServing ? ["Serving"] : []),
    "Cost",
    "Started",
  ];
  console.log(formatTable(headers, rows));
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

/** Dimensions `--serving-unknown` accepts; each selects null inside its
 * dimension (unknown is an operator, never a provider string). */
const SERVING_UNKNOWN_DIMENSIONS: readonly string[] = [
  "model",
  "provider",
  "host",
  "route",
  "service_tier",
];

/** Split repeatable flag values on commas: `--serving-unknown model,host`
 * and two separate flags must send the same repeated params. */
function splitCommaJoined(values: string[]): string[] {
  return [
    ...new Set(
      values.flatMap((raw) => raw.split(",")).map((value) => value.trim()),
    ),
  ].filter((value) => value !== "");
}

/** Compact one-line Serving cell (issue #307): the identity tuple for a
 * uniform run ("fireworks · priority"), "mixed · N" for several setups,
 * and a dim state word when nothing definite is showable. `partial` keeps
 * its base rendering plus the caveat so the setups stay visible. */
function formatServingCell(serving: ServingSummary | null | undefined): string {
  if (serving == null) return dim("-");
  if (serving.state === "no_data") return dim("no data");
  if (serving.state === "unknown") return dim("unknown");
  const partialSuffix = serving.state === "partial" ? ` ${dim("partial")}` : "";
  if (serving.total_groups <= 1) {
    const group = serving.groups[0];
    if (!group) return dim("partial");
    return `${groupIdentity(group.identity)}${partialSuffix}`;
  }
  return `mixed · ${serving.total_groups}${partialSuffix}`;
}

/** "provider · host · route · tier" with null parts skipped; the Execution
 * column already shows the model, so the identity stays terse. Capped like
 * the Hosts column so long route strings cannot blow up the table. */
function groupIdentity(identity: ServingIdentity): string {
  const parts = [
    identity.api_provider,
    identity.serving_host,
    identity.route,
    identity.service_tier,
  ].filter((part): part is string => !!part);
  const joined = parts.join(" · ");
  return joined.length > 32 ? `${joined.slice(0, 31)}…` : joined;
}
