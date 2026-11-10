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
  /** The same metric as a stable key; chip handlers dispatch on this. */
  kind: MetricKind;
  text: string;
}

/** The active ranges as chip text, e.g. "Cost: $0.10 to 0.50". */
export function metricChips(metrics: RunMetricFilters): MetricChip[] {
  const chips: MetricChip[] = [];
  const { cost, durationSeconds } = metrics;
  if (cost.min !== null || cost.max !== null) {
    chips.push({ metric: "Cost", kind: "cost", text: dollarsText(cost) });
  }
  if (durationSeconds.min !== null || durationSeconds.max !== null) {
    chips.push({ metric: "Duration", kind: "duration", text: minutesText(durationSeconds) });
  }
  return chips;
}

/** Clear one metric's range, keeping the other metric's range untouched. */
export function clearMetricRange(
  metrics: RunMetricFilters,
  kind: MetricKind,
): RunMetricFilters {
  return kind === "cost"
    ? { ...metrics, cost: EMPTY_METRIC_FILTERS.cost }
    : { ...metrics, durationSeconds: EMPTY_METRIC_FILTERS.durationSeconds };
}

function numberOrNull(source: ParamSource, key: string): number | null {
  const raw =
    source instanceof URLSearchParams ? source.get(key) : ((source as Record<string, unknown>)[key] as unknown);
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text === "") return null;
  const parsed = Number(text);
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

/** A named snapshot of the scope + metric params, stored as the URL's own
 * encoding so applying is a straight param swap. */
export interface SavedRunScope {
  id: string;
  name: string;
  /** The scope/metric query string, e.g. `label=team:platforms&since=` is
   * NOT included: only the params the rail owns. */
  params: string;
}

const SAVED_SCOPES_KEY = "runs-saved-scopes";

export function loadSavedScopes(): SavedRunScope[] {
  try {
    const raw = window.localStorage.getItem(SAVED_SCOPES_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is SavedRunScope =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as SavedRunScope).id === "string" &&
        typeof (entry as SavedRunScope).name === "string" &&
        typeof (entry as SavedRunScope).params === "string",
    );
  } catch {
    return [];
  }
}

export function saveSavedScopes(entries: SavedRunScope[]): void {
  try {
    window.localStorage.setItem(SAVED_SCOPES_KEY, JSON.stringify(entries));
  } catch {
    // Storage unavailable: saved scopes simply do not persist.
  }
}

/** The rail-owned params of a search string (scope + metric ranges),
 * re-encoded, so saving never captures page numbers or foreign filters. */
export function railOwnedParams(search: string): string {
  const owned = [
    "environment",
    "label",
    "cost_min",
    "cost_max",
    "duration_min",
    "duration_max",
  ];
  const params = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const key of owned) {
    for (const value of params.getAll(key)) kept.append(key, value);
  }
  return kept.toString();
}

/** A saved scope's params as an `updateUrl` patch: repeated params (the
 * rail writes `label` repeated) stay arrays, so every saved label returns
 * to the URL instead of only the last one surviving the round trip. */
export function savedScopePatch(params: string): Record<string, string | string[]> {
  const stored = new URLSearchParams(params);
  const patch: Record<string, string | string[]> = {};
  for (const key of new Set(stored.keys())) {
    const values = stored.getAll(key);
    patch[key] = values.length > 1 ? values : values[0];
  }
  return patch;
}
