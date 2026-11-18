// PROTOTYPE · throwaway data shaping for the run-trends UI prototype (see
// NOTES.md; delete once a variant wins). Two real fetches feed it: the
// project's batch runs (one trend point each) and its task runs (per-batch
// models, per-task matrix cells).

import { apiClient } from "@/lib/api-client";
import type {
  AgentTaskBatchRunSummary,
  AgentTaskRunSummary,
} from "@/lib/agent-task-api";

/** One point on the trend axis = one completed batch run, oldest first. */
export type TrendPoint = {
  batchRunId: string;
  createdAt: string;
  passedTasks: number;
  totalTasks: number;
  passedChecks: number;
  totalChecks: number;
  erroredTasks: number;
  totalCost: number | null;
  totalTokens: number | null;
  models: string[];
};

export const TREND_WINDOW = 60;

/** Lives here (not in the switcher) so the server page can read it · values
 * exported from "use client" modules arrive as client-reference proxies. */
export const PROTOTYPE_VARIANTS = [
  { key: "0", name: "Original" },
  { key: "A", name: "Checks Timeline" },
  { key: "B", name: "Task x Run Matrix" },
  { key: "C", name: "Runs Page Strips" },
  { key: "D", name: "Since-Last-Run Flips" },
  { key: "E", name: "Run Diff" },
  { key: "F", name: "Foundry Panels" },
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

/** The DB's configured_model never reaches the wire; run_configuration.model
 * is the adapter-reported value, model_providers the observed fallback. */
function runModel(run: AgentTaskRunSummary): string | null {
  return run.run_configuration?.model ?? run.model_providers?.[0]?.model ?? null;
}

/** Graded signal: checks passed over checks graded. Null when the run
 * errored before evaluation (totalChecks 0), never a fake zero. */
export function gradedRate(point: TrendPoint): number | null {
  return point.totalChecks > 0 ? point.passedChecks / point.totalChecks : null;
}

export function buildTrendData(
  batchRunsDesc: AgentTaskBatchRunSummary[],
  taskRuns: AgentTaskRunSummary[],
): TrendPoint[] {
  const runsByBatch = new Map<string, AgentTaskRunSummary[]>();
  for (const run of taskRuns) {
    const list = runsByBatch.get(run.batch_run_id);
    if (list) list.push(run);
    else runsByBatch.set(run.batch_run_id, [run]);
  }
  return [...batchRunsDesc]
    .slice(0, TREND_WINDOW)
    .reverse()
    .map((run) => {
      const models = new Set<string>();
      for (const taskRun of runsByBatch.get(run.id) ?? []) {
        const model = runModel(taskRun);
        if (model) models.add(model);
      }
      return {
        batchRunId: run.id,
        createdAt: run.created_at,
        passedTasks: run.passed_tasks,
        totalTasks: run.total_tasks,
        passedChecks: run.passed_checks,
        totalChecks: run.total_checks,
        erroredTasks: run.errored_tasks,
        totalCost: run.total_cost,
        totalTokens: run.total_tokens,
        models: [...models].sort(),
      };
    });
}

export type TaskCellStatus = "passed" | "failed" | "error";

function cellStatus(status: string): TaskCellStatus {
  return status === "passed" || status === "failed" ? status : "error";
}

export interface TaskMatrixCell {
  batchRunIndex: number;
  taskRunId: string;
  status: TaskCellStatus;
  passedChecks: number;
  totalChecks: number;
  model: string | null;
}

export interface TaskMatrixRow {
  taskId: string;
  taskPath: string;
  cells: TaskMatrixCell[];
  passedCount: number;
}

/** Rows = tasks seen in the window (most recently run first), columns = the
 * last batch runs (oldest left). */
export function buildTaskMatrix(
  points: TrendPoint[],
  taskRuns: AgentTaskRunSummary[],
  maxColumns = 40,
  maxRows = 25,
): { columns: TrendPoint[]; rows: TaskMatrixRow[] } {
  const columns = points.slice(-maxColumns);
  const columnIndex = new Map(columns.map((p, i) => [p.batchRunId, i]));
  const paths = new Map<string, string>();
  const byTask = new Map<string, TaskMatrixCell[]>();
  for (const run of taskRuns) {
    if (!paths.has(run.task_id)) paths.set(run.task_id, run.task_path);
    const batchRunIndex = columnIndex.get(run.batch_run_id);
    if (batchRunIndex === undefined) continue;
    const cell: TaskMatrixCell = {
      batchRunIndex,
      taskRunId: run.id,
      status: cellStatus(run.status),
      passedChecks: run.passed_checks,
      totalChecks: run.total_checks,
      model: runModel(run),
    };
    const list = byTask.get(run.task_id);
    if (list) list.push(cell);
    else byTask.set(run.task_id, [cell]);
  }
  const lastRunIndex = (cells: TaskMatrixCell[]) =>
    Math.max(...cells.map((c) => c.batchRunIndex));
  const rows = [...byTask.entries()]
    .sort(
      (a, b) => lastRunIndex(b[1]) - lastRunIndex(a[1]) || a[0].localeCompare(b[0]),
    )
    .slice(0, maxRows)
    .map(([taskId, cells]) => ({
      taskId,
      taskPath: paths.get(taskId) ?? taskId,
      cells: [...cells].sort((a, b) => a.batchRunIndex - b.batchRunIndex),
      passedCount: cells.filter((c) => c.status === "passed").length,
    }));
  return { columns, rows };
}

export interface TaskLatestResult {
  taskId: string;
  taskPath: string;
  status: TaskCellStatus;
}

/** Latest run per task inside the window; feeds the "Tasks Passing" strip. */
export function latestTaskResults(
  points: TrendPoint[],
  taskRuns: AgentTaskRunSummary[],
): TaskLatestResult[] {
  const columnIndex = new Map(points.map((p, i) => [p.batchRunId, i]));
  const latest = new Map<string, { run: AgentTaskRunSummary; index: number }>();
  for (const run of taskRuns) {
    const index = columnIndex.get(run.batch_run_id);
    if (index === undefined) continue;
    const current = latest.get(run.task_id);
    if (!current || index > current.index) {
      latest.set(run.task_id, { run, index });
    }
  }
  return [...latest.values()]
    .sort((a, b) => a.run.task_path.localeCompare(b.run.task_path))
    .map(({ run }) => ({
      taskId: run.task_id,
      taskPath: run.task_path,
      status: cellStatus(run.status),
    }));
}

export type FlipStatus = TaskCellStatus;

export interface FlipRunRef {
  taskRunId: string;
  status: FlipStatus;
  passedChecks: number;
  totalChecks: number;
  createdAt: string;
  model: string | null;
}

export type FlipKind = "regression" | "fix" | "stable-pass" | "stable-fail" | "new-error";

export interface TaskFlip {
  taskId: string;
  taskPath: string;
  prev: FlipRunRef;
  next: FlipRunRef;
  kind: FlipKind;
}

/** One classifier for D (since-last-run) and E (run diff) so the variants
 * cannot disagree. Error is never treated as failed: a prev error leaves no
 * verdict to compare against, so error->pass reads as passing-now (it joins
 * the "still passing" collapse, not the fixes) and error->fail lands in
 * stable-fail with the prev side rendered as error. Error->error keeps the
 * row in the new-error group: still no verdict, not a fail. */
export function kindFromStatuses(prev: FlipStatus, next: FlipStatus): FlipKind {
  if (next === "error") return "new-error";
  if (prev === "error") return next === "failed" ? "stable-fail" : "stable-pass";
  if (prev === "passed") return next === "failed" ? "regression" : "stable-pass";
  return next === "passed" ? "fix" : "stable-fail";
}

/** Task runs carry no created_at on the wire; the window point's date is the
 * honest always-present stand-in (same date variant B's column shows). */
function toFlipRef(run: AgentTaskRunSummary, batchCreatedAt: string): FlipRunRef {
  return {
    taskRunId: run.id,
    status: cellStatus(run.status),
    passedChecks: run.passed_checks,
    totalChecks: run.total_checks,
    createdAt: batchCreatedAt,
    model: runModel(run),
  };
}

/** Two most recent in-window runs per task. Tasks with fewer than 2 runs in
 * the window are not flips; variant B shows their history. */
export function buildTaskFlips(
  points: TrendPoint[],
  taskRuns: AgentTaskRunSummary[],
): TaskFlip[] {
  const columnIndex = new Map(points.map((p, i) => [p.batchRunId, i]));
  const byTask = new Map<string, { run: AgentTaskRunSummary; index: number }[]>();
  for (const run of taskRuns) {
    const index = columnIndex.get(run.batch_run_id);
    if (index === undefined) continue;
    const list = byTask.get(run.task_id);
    if (list) list.push({ run, index });
    else byTask.set(run.task_id, [{ run, index }]);
  }
  const flips: TaskFlip[] = [];
  for (const [taskId, runs] of byTask) {
    if (runs.length < 2) continue;
    const sorted = runs.toSorted(
      (a, b) => a.index - b.index || a.run.id.localeCompare(b.run.id),
    );
    const prev = sorted[sorted.length - 2];
    const next = sorted[sorted.length - 1];
    const prevRef = toFlipRef(prev.run, points[prev.index].createdAt);
    const nextRef = toFlipRef(next.run, points[next.index].createdAt);
    flips.push({
      taskId,
      taskPath: next.run.task_path,
      prev: prevRef,
      next: nextRef,
      kind: kindFromStatuses(prevRef.status, nextRef.status),
    });
  }
  return flips.sort((a, b) => a.taskPath.localeCompare(b.taskPath));
}

export interface RunDiffEntry {
  taskId: string;
  taskPath: string;
  base: FlipRunRef | null;
  cand: FlipRunRef | null;
}

/** Per-task diff of two batch runs from the window. A side is null when the
 * task did not run in that batch; with 1-task-per-batch data the null-side
 * rows dominate, which is part of what variant E demonstrates. */
export function buildRunDiff(
  points: TrendPoint[],
  taskRuns: AgentTaskRunSummary[],
  baseBatchRunId: string,
  candBatchRunId: string,
): { base: TrendPoint; cand: TrendPoint; entries: RunDiffEntry[] } {
  const base = points.find((p) => p.batchRunId === baseBatchRunId) ?? points[0];
  const cand = points.find((p) => p.batchRunId === candBatchRunId) ?? points[0];
  const byTask = new Map<
    string,
    { taskPath: string; base: FlipRunRef | null; cand: FlipRunRef | null }
  >();
  for (const run of taskRuns) {
    if (run.batch_run_id !== base.batchRunId && run.batch_run_id !== cand.batchRunId) {
      continue;
    }
    const batch = run.batch_run_id === base.batchRunId ? base : cand;
    let entry = byTask.get(run.task_id);
    if (!entry) {
      entry = { taskPath: run.task_path, base: null, cand: null };
      byTask.set(run.task_id, entry);
    }
    if (run.batch_run_id === base.batchRunId) entry.base = toFlipRef(run, batch.createdAt);
    else entry.cand = toFlipRef(run, batch.createdAt);
  }
  const entries: RunDiffEntry[] = [...byTask.entries()]
    .map(([taskId, entry]) => ({ taskId, ...entry }))
    .sort((a, b) => a.taskPath.localeCompare(b.taskPath));
  return { base, cand, entries };
}

const monthDay = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

export function formatDateTick(iso: string): string {
  return monthDay.format(new Date(iso));
}

/** Stable across server/client render: read the ISO string, no local time. */
export function formatDateWithTime(iso: string): string {
  return `${formatDateTick(iso)} ${iso.slice(11, 16)} UTC`;
}

/** Strip a provider/recording prefix ("recorded:deepseek/x" -> "deepseek/x"). */
export function shortModel(model: string): string {
  const cut = model.indexOf(":");
  const base = cut >= 0 ? model.slice(cut + 1) : model;
  return base.length > 24 ? `${base.slice(0, 23)}…` : base;
}

export function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatCompact(value: number): string {
  return compactNumber.format(value);
}
