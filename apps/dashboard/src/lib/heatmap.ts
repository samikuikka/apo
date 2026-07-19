// Percentile-based heatmap coloring for trace metrics (Langfuse-style).
//
// Colors reflect a value's position within the visible dataset rather than
// fixed absolute thresholds, so a naturally-slow workload (e.g. agent-task
// traces) doesn't render entirely red. The scale is clamped to p2..p98 so a
// single outlier can't flatten the rest of the range.

const cache = new WeakMap<readonly unknown[], Map<string, number[]>>();

/** Sorted (asc) numeric values for a metric across the given rows, memoized
 *  per rows-reference + key so repeated cells in the same render are O(1). */
export function sortedMetric<T>(
  rows: readonly T[],
  key: string,
  select: (row: T) => number,
): number[] {
  let inner = cache.get(rows);
  if (!inner) {
    inner = new Map();
    cache.set(rows, inner);
  }
  let arr = inner.get(key);
  if (!arr) {
    arr = rows
      .flatMap((row) => {
        const v = select(row);
        return Number.isFinite(v) && v > 0 ? [v] : [];
      })
      .sort((a, b) => a - b);
    inner.set(key, arr);
  }
  return arr;
}

function quantile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const i = (sortedAsc.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (i - lo);
}

/** How "hot" (bad) a value is relative to its dataset, in [0, 1].
 *  Scale is clamped to p2..p98; a uniform dataset returns 0 (neutral). */
export function heatFraction(
  value: number,
  sortedAsc: readonly number[],
): number {
  if (!Number.isFinite(value) || sortedAsc.length === 0) return 0;
  const lo = quantile(sortedAsc, 0.02);
  const hi = quantile(sortedAsc, 0.98);
  if (hi <= lo) return 0;
  return Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
}

/** Green (good) -> amber -> red (bad) for a fraction in [0, 1]. */
export function heatColor(fraction: number): string {
  const f = Math.max(0, Math.min(1, fraction));
  const hue = 140 * (1 - f); // 140 (green) -> 0 (red)
  const light = 42 - 6 * f; // slightly darker when hot
  return `hsl(${Math.round(hue)} 70% ${Math.round(light)}%)`;
}
