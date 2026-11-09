/**
 * Range filters over stored run metrics (batch cost and duration), carried in
 * the URL with the list API's own parameter names: ``cost_min``/``cost_max``
 * in dollars, ``duration_min``/``duration_max`` in seconds. Same philosophy
 * as the scope: the URL is the whole state, so a filtered view is a
 * shareable link.
 */

import type { SearchParamQuery } from "@/lib/run-cohort";

/** Page search params (server) or `useSearchParams` (client), like run-scope. */
type ParamSource = SearchParamQuery | URLSearchParams;

export interface MetricRange {
  min: number | null;
  max: number | null;
}

export interface RunMetricFilters {
  /** Batch cost rollup in dollars (sum of its child runs). */
  cost: MetricRange;
  /** Batch wall-clock duration in seconds. */
  durationSeconds: MetricRange;
}

export const EMPTY_METRIC_FILTERS: RunMetricFilters = {
  cost: { min: null, max: null },
  durationSeconds: { min: null, max: null },
};

export function parseMetricFilters(source: ParamSource): RunMetricFilters {
  return {
    cost: { min: numberOrNull(source, "cost_min"), max: numberOrNull(source, "cost_max") },
    durationSeconds: {
      min: numberOrNull(source, "duration_min"),
      max: numberOrNull(source, "duration_max"),
    },
  };
}

/** The four params as `updateUrl` values: a formatted number or null. */
export function metricFilterParams(
  metrics: RunMetricFilters,
): Record<"cost_min" | "cost_max" | "duration_min" | "duration_max", string | null> {
  return {
    cost_min: formatBound(metrics.cost.min),
    cost_max: formatBound(metrics.cost.max),
    duration_min: formatBound(metrics.durationSeconds.min),
    duration_max: formatBound(metrics.durationSeconds.max),
  };
}

/** The ranges as list-API query options (`listAgentTaskBatchRuns`). */
export function metricQuery(metrics: RunMetricFilters): {
  cost_min?: number;
  cost_max?: number;
  duration_min?: number;
  duration_max?: number;
} {
  return {
    cost_min: metrics.cost.min ?? undefined,
    cost_max: metrics.cost.max ?? undefined,
    duration_min: metrics.durationSeconds.min ?? undefined,
    duration_max: metrics.durationSeconds.max ?? undefined,
  };
}

export function isMetricFilterActive(metrics: RunMetricFilters): boolean {
  return (
    metrics.cost.min !== null ||
    metrics.cost.max !== null ||
    metrics.durationSeconds.min !== null ||
    metrics.durationSeconds.max !== null
  );
}

export interface MetricPreset {
  label: string;
  /** The cutoffs the preset stands for, shown after the label. */
  detail: string;
  min: number | null;
  max: number | null;
}

/** Which stored metric a preset buckets; only the wording differs. */
export type MetricKind = "cost" | "duration";

export interface MetricQuantiles {
  p20: number;
  p50: number;
  p80: number;
}

/**
 * Range presets from the project's own distribution: cheapest/fastest 20%,
 * the typical middle, costliest/slowest 20%. Fixed cutoffs cannot fit every
 * model mix (a cheap-model suite would put every run in one bucket), so the
 * boundaries are the project's p20 and p80. No quantiles, or a degenerate
 * spread (p20 = p80), yields no presets: the free min/max inputs remain.
 */
export function metricPresets(
  quantiles: MetricQuantiles | null | undefined,
  kind: MetricKind,
): MetricPreset[] {
  if (!quantiles || !(quantiles.p20 < quantiles.p80)) return [];
  const bound = (value: number) =>
    kind === "cost" ? `$${trimFloat(value)}` : minutesLabel(value);
  const names =
    kind === "cost"
      ? { low: "Cheapest 20%", mid: "Typical", high: "Costliest 20%" }
      : { low: "Fastest 20%", mid: "Typical", high: "Slowest 20%" };
  return [
    { label: names.low, detail: `under ${bound(quantiles.p20)}`, min: null, max: quantiles.p20 },
    {
      label: names.mid,
      detail: `${bound(quantiles.p20)} to ${bound(quantiles.p80)}`,
      min: quantiles.p20,
      max: quantiles.p80,
    },
    { label: names.high, detail: `over ${bound(quantiles.p80)}`, min: quantiles.p80, max: null },
  ];
}

/** One-line context under the inputs, e.g. "median $0.23". */
export function medianLabel(quantiles: MetricQuantiles | null | undefined, kind: MetricKind): string | null {
  if (!quantiles) return null;
  const bound = kind === "cost" ? `$${trimFloat(quantiles.p50)}` : minutesLabel(quantiles.p50);
  return `median ${bound}`;
}

function minutesLabel(seconds: number): string {
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  if (seconds < 60) return `${trimFloat(seconds)} s`;
  return `${trimFloat(seconds / 60)} min`;
}

function trimFloat(value: number): string {
  return String(Number(value.toFixed(2)));
}

export interface MetricChip {
  /** Which metric: "Cost" or "Duration". */
  metric: string;
  text: string;
}

/** The active ranges as chip text, e.g. "Cost: $0.10 to 0.50". */
export function metricChips(metrics: RunMetricFilters): MetricChip[] {
  const chips: MetricChip[] = [];
  const { cost, durationSeconds } = metrics;
  if (cost.min !== null || cost.max !== null) {
    chips.push({ metric: "Cost", text: dollarsText(cost) });
  }
  if (durationSeconds.min !== null || durationSeconds.max !== null) {
    chips.push({ metric: "Duration", text: minutesText(durationSeconds) });
  }
  return chips;
}

function numberOrNull(source: ParamSource, key: string): number | null {
  const raw =
    source instanceof URLSearchParams ? source.get(key) : ((source as Record<string, unknown>)[key] as unknown);
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function formatBound(value: number | null): string | null {
  return value === null ? null : String(value);
}

function dollarsText(range: MetricRange): string {
  if (range.min !== null && range.max !== null) {
    return `$${range.min} to ${range.max}`;
  }
  if (range.min !== null) return `over $${range.min}`;
  return `under $${range.max}`;
}

function minutesText(range: MetricRange): string {
  const toMin = (seconds: number) => (seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`);
  if (range.min !== null && range.max !== null) {
    return `${toMin(range.min)} to ${toMin(range.max)}`;
  }
  if (range.min !== null) return `over ${toMin(range.min)}`;
  return `under ${toMin(range.max ?? 0)}`;
}
