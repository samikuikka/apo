// PROTOTYPE · throwaway data shaping for the suite-health UI prototype (see
// NOTES.md; delete once a variant wins). Two sources land in the same
// HealthRun[] shape (the project's real task runs, or the deterministic
// fixture), then classifyTaskHealth turns each task's window of runs into the
// review states the variants render. Belief 9: surface tests that never fail.

import { apiClient } from "@/lib/api-client";
import type {
  AgentTaskBatchRunSummary,
  AgentTaskRunSummary,
} from "@/lib/agent-task-api";

export type HealthOutcome = "passed" | "failed" | "error";

/** One task run reduced to what a health verdict needs. */
export interface HealthRun {
  taskRunId: string;
  taskId: string;
  taskPath: string;
  outcome: HealthOutcome;
  model: string | null;
  at: string;
  cost: number | null;
}

export type HealthState =
  | "sparse" // fewer than MIN_GRADED graded runs: no verdict yet
  | "erroring" // high error share: infrastructure, not a verdict signal
  | "quiet" // every graded run passed, but only one model ran it
  | "saturated" // every graded run passed under 2+ models: prune or harden
  | "stuck" // long all-fail streak under every model: inspect the task
  | "steady" // mixed outcomes, similar across models
  | "healthy"; // models disagree: the task separates setups

export interface HealthFacet {
  model: string;
  graded: number;
  passed: number;
  passRate: number;
}

export interface TaskHealth {
  taskId: string;
  taskPath: string;
  displayName: string;
  runs: HealthRun[];
  graded: number;
  passed: number;
  failed: number;
  errors: number;
  lastFailedAt: string | null;
  lastErrorAt: string | null;
  lastPassedAt: string | null;
  failStreak: number;
  facets: HealthFacet[];
  facetSpread: number | null;
  distinctModels: number;
  windowDays: number | null;
  costPerMonth: number | null;
  avgCost: number | null;
  state: HealthState;
  reason: string;
}

/** Evidence window: the newest WINDOW_RUNS runs per task. */
export const WINDOW_RUNS = 60;
/** Graded (passed + failed) runs needed before any verdict is stated. */
export const MIN_GRADED = 5;
/** Graded runs per model before that model counts as a comparison facet. */
export const MIN_FACET_GRADED = 3;
/** Facet pass-rate spread that counts as "models disagree". */
export const SPREAD_THRESHOLD = 0.25;
/** Error share that reclassifies a task as an infrastructure problem. */
export const ERROR_SHARE = 0.2;
/** Consecutive most-recent failures (any model) that read as "stuck". */
export const STUCK_STREAK = 8;

export const PROTOTYPE_VARIANTS = [
  { key: "0", name: "Original" },
  { key: "A", name: "Never-Failing List" },
  { key: "B", name: "Tasks Column" },
] as const;

/** No shared wrapper lists a project's task runs without a task_id, so this
 * owns the call (same apiClient seam as agent-task-api.ts). */
export const listProjectTaskRuns = (
  projectId: string,
  limit = 5000,
): Promise<AgentTaskRunSummary[]> =>
  apiClient("/v1/agent-task-runs", {
    cache: "no-store",
    query: { project: projectId, limit },
  });

function outcomeOf(status: string): HealthOutcome {
  return status === "passed" || status === "failed" ? status : "error";
}

/** The DB's configured_model never reaches the wire; run_configuration.model
 * is the adapter-reported value, model_providers the observed fallback. */
function modelOf(run: AgentTaskRunSummary): string | null {
  return (
    run.run_configuration?.model ??
    run.model_providers?.[0]?.model ??
    run.primary_model ??
    null
  );
}

/** Shape the real wire data into HealthRun[], newest last per task. */
export function buildHealthRuns(
  batchRunsDesc: AgentTaskBatchRunSummary[],
  taskRuns: AgentTaskRunSummary[],
): Map<string, HealthRun[]> {
  const batchDate = new Map(batchRunsDesc.map((b) => [b.id, b.created_at]));
  const byTask = new Map<string, HealthRun[]>();
  for (const run of taskRuns) {
    const at =
      run.started_at ??
      batchDate.get(run.batch_run_id) ??
      run.completed_at ??
      "";
    const record: HealthRun = {
      taskRunId: run.id,
      taskId: run.task_id,
      taskPath: run.task_path,
      outcome: outcomeOf(run.status),
      model: modelOf(run),
      at,
      cost: run.total_cost,
    };
    const list = byTask.get(run.task_id);
    if (list) list.push(record);
    else byTask.set(run.task_id, [record]);
  }
  for (const list of byTask.values()) {
    list.sort((a, b) => a.at.localeCompare(b.at) || a.taskRunId.localeCompare(b.taskRunId));
  }
  return byTask;
}

function facetsOf(runs: HealthRun[]): HealthFacet[] {
  const acc = new Map<string, { graded: number; passed: number }>();
  for (const run of runs) {
    if (run.model === null || run.outcome === "error") continue;
    const slot = acc.get(run.model) ?? { graded: 0, passed: 0 };
    slot.graded += 1;
    if (run.outcome === "passed") slot.passed += 1;
    acc.set(run.model, slot);
  }
  return [...acc.entries()]
    .filter(([, slot]) => slot.graded >= MIN_FACET_GRADED)
    .map(([model, slot]) => ({
      model,
      graded: slot.graded,
      passed: slot.passed,
      passRate: slot.passed / slot.graded,
    }))
    .sort((a, b) => b.graded - a.graded);
}

function classify(
  runs: HealthRun[],
  counts: { graded: number; passed: number; failed: number; errors: number },
  facets: HealthFacet[],
  failStreak: number,
): { state: HealthState; reason: string } {
  const spread =
    facets.length >= 2
      ? Math.max(...facets.map((f) => f.passRate)) -
        Math.min(...facets.map((f) => f.passRate))
      : null;
  if (counts.graded < MIN_GRADED) {
    return {
      state: "sparse",
      reason: `Only ${counts.graded} graded ${counts.graded === 1 ? "run" : "runs"}; not enough to judge yet.`,
    };
  }
  if (counts.errors / Math.max(1, runs.length) >= ERROR_SHARE) {
    return {
      state: "erroring",
      reason: `${counts.errors} of ${runs.length} runs errored before a verdict.`,
    };
  }
  const everywhere = facets.length >= 2 ? "under every model that ran it" : "under the only model that ran it";
  if (counts.failed === 0) {
    if (facets.length >= 2) {
      return {
        state: "saturated",
        reason: `Passed all ${counts.graded} runs under all ${facets.length} models. Nothing it currently guards can fail it.`,
      };
    }
    return {
      state: "quiet",
      reason: `Passed all ${counts.graded} runs, but only one model has run it. Run a second model to learn whether it discriminates.`,
    };
  }
  if (failStreak >= STUCK_STREAK) {
    return {
      state: "stuck",
      reason: `Failed the last ${failStreak} runs ${everywhere}. Inspect the task or accept it as known-hard.`,
    };
  }
  if (spread !== null && spread >= SPREAD_THRESHOLD) {
    const best = facets.reduce((a, b) => (a.passRate > b.passRate ? a : b));
    const worst = facets.reduce((a, b) => (a.passRate < b.passRate ? a : b));
    return {
      state: "healthy",
      reason: `Models disagree: ${shortModel(best.model)} ${formatPercent(best.passRate)}, ${shortModel(worst.model)} ${formatPercent(worst.passRate)}.`,
    };
  }
  return {
    state: "steady",
    reason: `Mixed results, similar across models (${counts.passed}/${counts.graded} passed).`,
  };
}

/** Turn one task's window of runs (newest last) into the review object. */
export function classifyTaskHealth(
  taskId: string,
  taskPath: string,
  allRuns: HealthRun[],
): TaskHealth {
  const runs = allRuns.slice(-WINDOW_RUNS);
  const graded = runs.filter((r) => r.outcome !== "error");
  const passed = graded.filter((r) => r.outcome === "passed").length;
  const failed = graded.length - passed;
  const errors = runs.length - graded.length;
  let failStreak = 0;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    if (runs[i].outcome === "failed") failStreak += 1;
    else break;
  }
  const facets = facetsOf(runs);
  const { state, reason } = classify(runs, { graded: graded.length, passed, failed, errors }, facets, failStreak);
  const dated = runs.filter((r) => r.at);
  const windowDays =
    dated.length >= 2
      ? Math.round(
          (Date.parse(dated[dated.length - 1].at) - Date.parse(dated[0].at)) / 86_400_000,
        )
      : null;
  const lastFailedAt =
    [...runs].reverse().find((r) => r.outcome === "failed")?.at ?? null;
  const lastErrorAt =
    [...runs].reverse().find((r) => r.outcome === "error")?.at ?? null;
  const lastPassedAt =
    [...runs].reverse().find((r) => r.outcome === "passed")?.at ?? null;
  // Cost per month: priced runs in the 30 days before the task's newest run.
  const anchor = dated.length > 0 ? Date.parse(dated[dated.length - 1].at) : null;
  const priced = runs.filter((r) => r.cost !== null);
  const monthRuns =
    anchor === null
      ? []
      : runs.filter((r) => r.at && anchor - Date.parse(r.at) <= 30 * 86_400_000);
  const monthPriced = monthRuns.filter((r) => r.cost !== null);
  return {
    taskId,
    taskPath,
    displayName: taskPath.split("/").pop() ?? taskPath,
    runs,
    graded: graded.length,
    passed,
    failed,
    errors,
    lastFailedAt,
    lastErrorAt,
    lastPassedAt,
    failStreak,
    facets,
    facetSpread:
      facets.length >= 2
        ? Math.max(...facets.map((f) => f.passRate)) -
          Math.min(...facets.map((f) => f.passRate))
        : null,
    distinctModels: new Set(runs.map((r) => r.model).filter(Boolean)).size,
    windowDays,
    costPerMonth:
      monthPriced.length > 0
        ? monthPriced.reduce((sum, r) => sum + (r.cost ?? 0), 0) *
          (monthRuns.length / monthPriced.length)
        : null,
    avgCost:
      priced.length > 0
        ? priced.reduce((sum, r) => sum + (r.cost ?? 0), 0) / priced.length
        : null,
    state,
    reason,
  };
}

/** Full real-data path: wire objects to classified tasks, attention first. */
export function buildHealthData(
  batchRunsDesc: AgentTaskBatchRunSummary[],
  taskRuns: AgentTaskRunSummary[],
): TaskHealth[] {
  const byTask = buildHealthRuns(batchRunsDesc, taskRuns);
  const paths = new Map<string, string>();
  for (const run of taskRuns) paths.set(run.task_id, run.task_path);
  const tasks = [...byTask.entries()].map(([taskId, runs]) =>
    classifyTaskHealth(taskId, paths.get(taskId) ?? taskId, runs),
  );
  return tasks.sort((a, b) => stateRank(a.state) - stateRank(b.state) || a.taskPath.localeCompare(b.taskPath));
}

const STATE_RANK: Record<HealthState, number> = {
  saturated: 0,
  stuck: 1,
  erroring: 2,
  quiet: 3,
  steady: 4,
  healthy: 5,
  sparse: 6,
};

export function stateRank(state: HealthState): number {
  return STATE_RANK[state];
}

/** State → the one-line label the tables show in the Health column. */
export function stateLabel(task: TaskHealth): string {
  switch (task.state) {
    case "saturated":
      return `quiet ${task.graded}/${task.graded}`;
    case "stuck":
      return `stuck, last ${task.failStreak}`;
    case "erroring":
      return `errors ${task.errors}/${task.runs.length}`;
    case "quiet":
      return `quiet, one model`;
    case "healthy":
      return "separates models";
    case "steady":
      return "mixed, all models";
    case "sparse":
      return `n=${task.graded}`;
  }
}

const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

export function formatDateTick(iso: string): string {
  return monthDay.format(new Date(iso));
}

/** The single user-facing health metric: when did this task last fail,
 * relative to the task's newest run. "never" is the whole verdict. */
export function lastFailedLabel(task: TaskHealth): string {
  if (task.lastFailedAt === null) return "never";
  const last = task.runs[task.runs.length - 1]?.at;
  if (!last) return formatDateTick(task.lastFailedAt);
  const days = Math.round(
    (Date.parse(last) - Date.parse(task.lastFailedAt)) / 86_400_000,
  );
  if (days <= 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return formatDateTick(task.lastFailedAt);
}

/** For an always-failing task: when it last passed ("failing since"). */
export function failingSinceLabel(task: TaskHealth): string {
  if (task.lastPassedAt === null) return "always";
  return `since ${formatDateTick(task.lastPassedAt)}`;
}

/** Strip a provider/recording prefix ("recorded:deepseek/x" -> "deepseek/x"). */
export function shortModel(model: string): string {
  const cut = model.indexOf(":");
  const base = cut >= 0 ? model.slice(cut + 1) : model;
  return base.length > 22 ? `${base.slice(0, 21)}…` : base;
}

export function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function formatDollars(value: number | null): string {
  if (value === null) return "unpriced";
  return value >= 1 ? `$${value.toFixed(2)}` : `¢${Math.round(value * 100)}`;
}
