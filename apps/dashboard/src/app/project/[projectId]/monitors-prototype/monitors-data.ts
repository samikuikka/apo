// PROTOTYPE — throwaway code answering "what should apo's Monitors page look
// like?" (respan-inspired). Nothing here persists or calls mutating APIs.
// See NOTES.md next to this file; delete once the answer is captured.

import type { AgentTaskBatchRunSummary } from "@/lib/agent-task-api";

export type MonitorMetricId =
  | "suite_pass_rate"
  | "checks_pass_rate"
  | "failed_tasks"
  | "failed_checks"
  | "errored_tasks"
  | "error_rate"
  | "total_cost"
  | "avg_cost"
  | "peak_cost"
  | "avg_duration_s"
  | "peak_duration_s"
  | "p95_duration_s"
  | "total_tokens"
  | "reasoning_tokens";
export type MonitorOperator = "lt" | "gt" | "gte";
export type MonitorWindow = "1h" | "6h" | "24h" | "7d";
export type MonitorLifecycle = "deployed" | "paused" | "draft";
/** Channel vocabulary matches what automations can deliver TODAY
 * (services/automations.py): webhook, github_issue, slack. Email is NOT
 * wired to automations — the EmailService exists but serves auth/invites,
 * so the mock must not offer it. */
export type ChannelKind = "slack" | "webhook" | "github_issue";

export interface MonitorWhere {
  field: string;
  operator: string;
  value: string;
}

export interface MonitorChannel {
  kind: ChannelKind;
  target: string;
}

export interface SeriesPoint {
  at: string;
  value: number | null;
}

export interface MonitorFire {
  id: string;
  at: string;
  batchRunId: string;
  headline: string;
  detail: string;
}

export interface MonitorStub {
  id: string;
  name: string;
  description: string;
  metric: MonitorMetricId;
  operator: MonitorOperator;
  threshold: number;
  window: MonitorWindow;
  where: MonitorWhere[];
  channels: MonitorChannel[];
  lifecycle: MonitorLifecycle;
  breached: boolean;
  currentValue: number | null;
  series: SeriesPoint[];
  fires: MonitorFire[];
}

export const MONITOR_METRICS: Record<MonitorMetricId, { label: string }> = {
  suite_pass_rate: { label: "Suite pass rate" },
  checks_pass_rate: { label: "Checks pass rate" },
  failed_tasks: { label: "Failed tasks" },
  failed_checks: { label: "Failed checks" },
  errored_tasks: { label: "Errored tasks" },
  error_rate: { label: "Error rate" },
  total_cost: { label: "Total cost" },
  avg_cost: { label: "Average cost" },
  peak_cost: { label: "Peak cost" },
  avg_duration_s: { label: "Average duration" },
  peak_duration_s: { label: "Peak duration" },
  p95_duration_s: { label: "P95 duration" },
  total_tokens: { label: "Total tokens" },
  reasoning_tokens: { label: "Reasoning tokens" },
};

/** respan-style grouped metric picker: categories ("folders") open to reveal
 * their children (Errors → error count, error rate; Cost → total, average,
 * peak…). Every metric below is computable from real batch-run fields. */
export interface MetricGroup {
  category: string;
  metrics: MonitorMetricId[];
}

export const METRIC_TREE: MetricGroup[] = [
  { category: "Pass rate", metrics: ["suite_pass_rate", "checks_pass_rate"] },
  { category: "Failures", metrics: ["failed_tasks", "failed_checks"] },
  { category: "Errors", metrics: ["errored_tasks", "error_rate"] },
  { category: "Cost", metrics: ["total_cost", "avg_cost", "peak_cost"] },
  { category: "Latency", metrics: ["avg_duration_s", "peak_duration_s", "p95_duration_s"] },
  { category: "Tokens", metrics: ["total_tokens", "reasoning_tokens"] },
];

export function categoryOfMetric(id: MonitorMetricId): string {
  return METRIC_TREE.find((g) => g.metrics.includes(id))?.category ?? "";
}

export const OPERATOR_LABELS: Record<MonitorOperator, string> = {
  lt: "<",
  gt: ">",
  gte: "≥",
};

/** Lives here (not in the switcher) so the server page can read it — values
 * exported from "use client" modules arrive as client-reference proxies. */
export const PROTOTYPE_VARIANTS = [
  { key: "A", name: "Trigger builder" },
  { key: "B", name: "Status board" },
  { key: "C", name: "Alert inbox" },
] as const;

export const CHANNEL_LABELS: Record<ChannelKind, string> = {
  slack: "Slack",
  webhook: "Webhook",
  github_issue: "GitHub Issue",
};

export const WHERE_FIELDS = [
  "task",
  "model",
  "provider",
  "environment",
  "trigger.source",
] as const;

const PERCENT_METRICS: MonitorMetricId[] = [
  "suite_pass_rate",
  "checks_pass_rate",
  "error_rate",
];
const COST_METRICS: MonitorMetricId[] = ["total_cost", "avg_cost", "peak_cost"];
const DURATION_METRICS: MonitorMetricId[] = [
  "avg_duration_s",
  "peak_duration_s",
  "p95_duration_s",
];
const TOKEN_METRICS: MonitorMetricId[] = ["total_tokens", "reasoning_tokens"];

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatNumber(value: number): string {
  return Math.abs(value) >= 10000
    ? compactNumber.format(value)
    : String(Math.round(value));
}

export function formatMetricValue(
  metric: MonitorMetricId,
  value: number | null,
): string {
  if (value === null || Number.isNaN(value)) return "—";
  if (PERCENT_METRICS.includes(metric)) return `${Math.round(value * 100)}%`;
  if (COST_METRICS.includes(metric)) {
    return Math.abs(value) >= 10000
      ? `$${compactNumber.format(value)}`
      : `$${value.toFixed(2)}`;
  }
  if (DURATION_METRICS.includes(metric)) return `${value.toFixed(1)}s`;
  if (TOKEN_METRICS.includes(metric)) return compactNumber.format(value);
  return String(Math.round(value));
}

export function formatThreshold(
  metric: MonitorMetricId,
  threshold: number,
): string {
  if (PERCENT_METRICS.includes(metric)) return `${Math.round(threshold * 100)}%`;
  if (COST_METRICS.includes(metric)) return `$${formatNumber(threshold)}`;
  if (DURATION_METRICS.includes(metric)) return `${threshold}s`;
  return formatNumber(threshold);
}

export function breaches(
  operator: MonitorOperator,
  value: number | null,
  threshold: number,
): boolean {
  if (value === null) return false;
  switch (operator) {
    case "lt":
      return value < threshold;
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
  }
}

export function triggerSentence(m: {
  metric: MonitorMetricId;
  operator: MonitorOperator;
  threshold: number;
  window: MonitorWindow;
}): string {
  return `${MONITOR_METRICS[m.metric].label} ${OPERATOR_LABELS[m.operator]} ${formatThreshold(m.metric, m.threshold)} over ${m.window}`;
}

export function whereSummary(where: MonitorWhere[]): string {
  if (where.length === 0) return "all runs";
  return where.map((w) => `${w.field} ${w.operator} ${w.value}`).join(" · ");
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 30 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

function runDurationSeconds(run: AgentTaskBatchRunSummary): number | null {
  if (!run.started_at || !run.completed_at) return null;
  return (
    (new Date(run.completed_at).getTime() -
      new Date(run.started_at).getTime()) /
    1000
  );
}

/** Value of a metric within one batch run — one sparkline point. */
function runMetricValue(
  run: AgentTaskBatchRunSummary,
  metric: MonitorMetricId,
): number | null {
  switch (metric) {
    case "suite_pass_rate":
      return run.total_tasks > 0 ? run.passed_tasks / run.total_tasks : null;
    case "checks_pass_rate":
      return run.total_checks > 0 ? run.passed_checks / run.total_checks : null;
    case "failed_tasks":
      return run.failed_tasks;
    case "failed_checks":
      return Math.max(0, run.total_checks - run.passed_checks);
    case "errored_tasks":
      return run.errored_tasks;
    case "error_rate":
      return run.total_tasks > 0 ? run.errored_tasks / run.total_tasks : null;
    case "total_cost":
      return run.total_cost;
    case "avg_cost":
      return run.total_cost !== null && run.total_tasks > 0
        ? run.total_cost / run.total_tasks
        : null;
    case "peak_cost":
      return run.total_cost;
    case "avg_duration_s":
    case "peak_duration_s":
    case "p95_duration_s":
      return runDurationSeconds(run);
    case "total_tokens":
      return run.total_tokens;
    case "reasoning_tokens":
      return run.total_reasoning_tokens ?? null;
  }
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[index];
}

/** Value of a metric across the fetched runs — the "current" readout. */
function aggregateMetric(
  runs: AgentTaskBatchRunSummary[],
  metric: MonitorMetricId,
): number | null {
  if (runs.length === 0) return null;
  const sum = (pick: (r: AgentTaskBatchRunSummary) => number | null) => {
    let acc = 0;
    let any = false;
    for (const r of runs) {
      const v = pick(r);
      if (v !== null) {
        acc += v;
        any = true;
      }
    }
    return any ? acc : null;
  };
  const values = (pick: (r: AgentTaskBatchRunSummary) => number | null) =>
    runs
      .map(pick)
      .filter((v): v is number => v !== null);

  switch (metric) {
    case "suite_pass_rate": {
      const total = sum((r) => r.total_tasks);
      const passed = sum((r) => r.passed_tasks);
      return total && passed !== null ? passed / total : null;
    }
    case "checks_pass_rate": {
      const total = sum((r) => r.total_checks);
      const passed = sum((r) => r.passed_checks);
      return total && passed !== null ? passed / total : null;
    }
    case "error_rate": {
      const total = sum((r) => r.total_tasks);
      const errored = sum((r) => r.errored_tasks);
      return total && errored !== null ? errored / total : null;
    }
    case "avg_cost": {
      const cost = sum((r) => r.total_cost);
      const tasks = sum((r) => r.total_tasks);
      return cost !== null && tasks ? cost / tasks : null;
    }
    case "peak_cost":
      return values((r) => r.total_cost).length > 0
        ? Math.max(...values((r) => r.total_cost))
        : null;
    case "avg_duration_s": {
      const durations = values(runDurationSeconds);
      return durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : null;
    }
    case "peak_duration_s":
      return values(runDurationSeconds).length > 0
        ? Math.max(...values(runDurationSeconds))
        : null;
    case "p95_duration_s":
      return percentile(values(runDurationSeconds), 0.95);
    default:
      return sum((r) => runMetricValue(r, metric));
  }
}

function runDetail(run: AgentTaskBatchRunSummary): string {
  return `${run.total_tasks} tasks · ${run.passed_tasks} passed · ${run.failed_tasks} failed · ${run.errored_tasks} errored`;
}

/** Project-wide current values, keyed by metric — lets the editor preview
 * stay truthful when the user flips the metric selector. */
export interface ProjectSnapshot {
  runCount: number;
  taskCount: number;
  detail: string;
  currentValues: Record<MonitorMetricId, number | null>;
}

export function projectSnapshot(
  runs: AgentTaskBatchRunSummary[],
): ProjectSnapshot {
  const metrics = Object.keys(MONITOR_METRICS) as MonitorMetricId[];
  const currentValues = Object.fromEntries(
    metrics.map((m) => [m, aggregateMetric(runs, m)]),
  ) as Record<MonitorMetricId, number | null>;
  const taskCount = runs.reduce((acc, r) => acc + r.total_tasks, 0);
  return {
    runCount: runs.length,
    taskCount,
    detail: `${runs.length} batch runs · ${taskCount} tasks`,
    currentValues,
  };
}

interface MonitorSeed {
  id: string;
  name: string;
  description: string;
  metric: MonitorMetricId;
  operator: MonitorOperator;
  threshold: number;
  window: MonitorWindow;
  where: MonitorWhere[];
  channels: MonitorChannel[];
  lifecycle: MonitorLifecycle;
}

const SEEDS: MonitorSeed[] = [
  {
    id: "pass-rate-floor",
    name: "Suite pass-rate floor",
    description: "The suite is only shippable above this floor.",
    metric: "suite_pass_rate",
    operator: "lt",
    threshold: 0.8,
    window: "24h",
    where: [],
    channels: [
      { kind: "slack", target: "#agent-alerts" },
      { kind: "webhook", target: "hooks.zapier.com/suite-health" },
    ],
    lifecycle: "deployed",
  },
  {
    id: "failure-spike",
    name: "Failure spike guard",
    description: "Catches a sudden cluster of failing tasks.",
    metric: "failed_tasks",
    operator: "gte",
    threshold: 1,
    window: "6h",
    where: [{ field: "model", operator: "=", value: "deepseek/deepseek-v4.1-flash" }],
    channels: [{ kind: "webhook", target: "hooks.zapier.com/t-agent-failures" }],
    lifecycle: "deployed",
  },
  {
    id: "latency-budget",
    name: "Suite latency budget",
    description: "The nightly sweep must finish inside the budget.",
    metric: "avg_duration_s",
    operator: "gt",
    threshold: 300,
    window: "24h",
    where: [],
    channels: [{ kind: "slack", target: "#suite-reports" }],
    lifecycle: "deployed",
  },
  {
    id: "hard-error-watch",
    name: "Hard-error watch",
    description: "Any errored (not failed) run is an infrastructure fault.",
    metric: "errored_tasks",
    operator: "gte",
    threshold: 1,
    window: "6h",
    where: [],
    channels: [{ kind: "github_issue", target: "apo/agent-demo" }],
    lifecycle: "deployed",
  },
  {
    id: "nightly-regression",
    name: "Nightly schedule regression",
    description: "Scheduled runs drift slower than manual ones — watch separately.",
    metric: "suite_pass_rate",
    operator: "lt",
    threshold: 0.9,
    window: "7d",
    where: [{ field: "trigger.source", operator: "=", value: "schedule" }],
    channels: [{ kind: "slack", target: "#nightly-reports" }],
    lifecycle: "paused",
  },
  {
    id: "checks-quality-floor",
    name: "Checks quality floor",
    description: "Draft — needs a destination before it can deploy.",
    metric: "checks_pass_rate",
    operator: "lt",
    threshold: 0.9,
    window: "7d",
    where: [{ field: "task", operator: "contains", value: "t-agent-demo" }],
    channels: [],
    lifecycle: "draft",
  },
];

/** Sensible defaults per metric, so the editor opens prefilled after the
 * preset pick (respan defers complexity the same way). */
export const DEFAULT_THRESHOLDS: Record<MonitorMetricId, number> = {
  suite_pass_rate: 0.8,
  checks_pass_rate: 0.8,
  failed_tasks: 1,
  failed_checks: 5,
  errored_tasks: 1,
  error_rate: 0.05,
  total_cost: 5,
  avg_cost: 1,
  peak_cost: 10,
  avg_duration_s: 300,
  peak_duration_s: 600,
  p95_duration_s: 600,
  total_tokens: 500000,
  reasoning_tokens: 100000,
};

export const DEFAULT_OPERATORS: Record<MonitorMetricId, MonitorOperator> = {
  suite_pass_rate: "lt",
  checks_pass_rate: "lt",
  failed_tasks: "gte",
  failed_checks: "gte",
  errored_tasks: "gte",
  error_rate: "lt",
  total_cost: "gt",
  avg_cost: "gt",
  peak_cost: "gt",
  avg_duration_s: "gt",
  peak_duration_s: "gt",
  p95_duration_s: "gt",
  total_tokens: "gt",
  reasoning_tokens: "gt",
};

/** Blank monitor for the create flow — mirrors respan's empty editor. */
export function blankMonitor(
  metric: MonitorMetricId = "suite_pass_rate",
  name = "Untitled automation",
): MonitorStub {
  return {
    id: "new",
    name,
    description: "",
    metric,
    operator: DEFAULT_OPERATORS[metric],
    threshold: DEFAULT_THRESHOLDS[metric],
    window: "24h",
    where: [],
    channels: [],
    lifecycle: "draft",
    breached: false,
    currentValue: null,
    series: [],
    fires: [],
  };
}

/** Builds the stub monitor list grounded in the project's real batch-run
 * history. Model: each completed batch run is one "evaluation" of every
 * monitor — the current value is the latest evaluation, a fire is a past
 * evaluation that breached (drafts have never deployed, so no fires). */
export function buildPrototypeMonitors(
  _projectId: string,
  batchRunsDesc: AgentTaskBatchRunSummary[],
): MonitorStub[] {
  const runs = [...batchRunsDesc].reverse(); // chronological
  const latest = runs.at(-1) ?? null;
  return SEEDS.map((seed) => {
    const series = runs.map((r) => ({
      at: r.created_at,
      value: runMetricValue(r, seed.metric),
    }));
    const currentValue = latest
      ? (runMetricValue(latest, seed.metric) ??
        aggregateMetric(runs, seed.metric))
      : aggregateMetric(runs, seed.metric);
    const breached =
      seed.lifecycle === "deployed" &&
      breaches(seed.operator, currentValue, seed.threshold);
    const fires =
      seed.lifecycle === "draft"
        ? []
        : runs
            .map((r) => ({ run: r, value: runMetricValue(r, seed.metric) }))
            .filter(({ value }) =>
              breaches(seed.operator, value, seed.threshold),
            )
            .slice(-8)
            .reverse()
            .map(({ run, value }) => ({
              id: `${seed.id}:${run.id}`,
              at: run.created_at,
              batchRunId: run.id,
              headline: `${MONITOR_METRICS[seed.metric].label} ${formatMetricValue(seed.metric, value)} ${OPERATOR_LABELS[seed.operator]} ${formatThreshold(seed.metric, seed.threshold)}`,
              detail: runDetail(run),
            }));
    return {
      ...seed,
      breached,
      currentValue,
      series,
      fires,
    };
  });
}
