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
  min: number | null;
  max: number | null;
}

export const COST_PRESETS: MetricPreset[] = [
  { label: "Under $0.10", min: null, max: 0.1 },
  { label: "$0.10 to 0.50", min: 0.1, max: 0.5 },
  { label: "Over $0.50", min: 0.5, max: null },
];

export const DURATION_PRESETS: MetricPreset[] = [
  { label: "Under 1 min", min: null, max: 60 },
  { label: "1 to 5 min", min: 60, max: 300 },
  { label: "Over 5 min", min: 300, max: null },
];

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
