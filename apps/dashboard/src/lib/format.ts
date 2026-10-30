export function formatInterval(ms: number | null): string {
  if (ms == null) return "\u2014";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins < 60) return `${mins}m ${String(secs).padStart(2, "0")}s`;
  const hrs = Math.floor(mins / 60);
  const rmins = mins % 60;
  return `${hrs}h ${String(rmins).padStart(2, "0")}m ${String(secs).padStart(2, "0")}s`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "\u2014";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Run duration in milliseconds from a run's started_at/completed_at pair.
 * Returns null when either timestamp is missing or invalid (e.g. a run that
 * errored before completing, or a legacy row with no timestamps). Callers feed
 * the result to {@link formatDuration} for the label and use the raw ms for
 * bar-fill proportions. Consolidates the duplicated start/end parsing that
 * lived inline in runs-client.tsx and the page.tsx files.
 */
export function runDurationMs(
  startedAt: string | null,
  completedAt: string | null,
): number | null {
  if (!startedAt || !completedAt) return null;
  const ms = parseUTC(completedAt).getTime() - parseUTC(startedAt).getTime();
  return ms >= 0 ? ms : null;
}

export function usdFormat(value: number | null): string {
  if (value == null) return "\u2014";
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

/**
 * Format a micro-USD integer as a USD string.
 * Costs are stored as integers (micro-USD = USD * 1e6); divide by 1e6 first.
 * Use this for call.cost / run.total_cost / breakdown values coming from the
 * backend current.
 */
export function formatCostMicro(microUsd: number | null | undefined): string {
  if (microUsd == null) return "\u2014";
  return usdFormat(microUsd / 1_000_000);
}

export function tokenFormat(value: number | null): string {
  if (value == null) return "\u2014";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** Input counts include cache reads, which bill at a fraction of the input rate. */
function cachedSuffix(cacheRead: number | null | undefined): string {
  return cacheRead != null && cacheRead > 0 ? ` (${tokenFormat(cacheRead)} cached)` : "";
}

/**
 * Render a single token count with the standard suffix — e.g. `1.5k tok`.
 * Use for total-only displays where no input/output breakdown is available.
 * With a cache read: `1.5k tok (1.2k cached)`.
 */
export function formatTokenTotal(value: number | null, cacheRead?: number | null): string {
  return `${tokenFormat(value)} tok${cachedSuffix(cacheRead)}`;
}

/**
 * Render an input → output token breakdown with the standard suffix —
 * e.g. `383→78 tok`. The arrow is the canonical "weird symbol" separator
 * used across every trace surface; the suffix is the unit. Both halves
 * go through {@link tokenFormat} so large numbers abbreviate to `k`/`M`.
 * With a cache read: `833.0k (655.5k cached)→15.8k tok`.
 */
export function formatTokenBreakdown(
  input: number | null,
  output: number | null,
  cacheRead?: number | null,
): string {
  return `${tokenFormat(input)}${cachedSuffix(cacheRead)}\u2192${tokenFormat(output)} tok`;
}

/** Hover (`title`) text splitting an input count into its cache parts; undefined when no cache was used. */
export function formatInputCacheSplit(
  input: number,
  cacheRead: number,
  cacheWrite: number,
): string | undefined {
  if (cacheRead <= 0 && cacheWrite <= 0) return undefined;
  const uncached = Math.max(input - cacheRead - cacheWrite, 0);
  return `Input ${tokenFormat(input)}: ${tokenFormat(cacheRead)} read from cache, ${tokenFormat(cacheWrite)} written to cache, ${tokenFormat(uncached)} uncached`;
}

/**
 * Parse a timestamp string as UTC. Backend stores UTC but SQLite may drop
 * the timezone suffix on read-back, causing browsers to interpret naive
 * timestamps as local time. This ensures UTC interpretation.
 */
export function parseUTC(value: string): Date {
  if (value.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(value)) {
    return new Date(value);
  }
  return new Date(value + "Z");
}

export function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "\u2014";
  const diff = Date.now() - parseUTC(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Render an ISO timestamp as a fixed `YYYY-MM-DD HH:MM:SS UTC` label with
 * seconds preserved. Pure string surgery — no Date round-trip, so the
 * naive-SQLite-read-back local-time trap {@link parseUTC} guards against
 * cannot bite and the stored precision is shown as-is.
 */
export function formatUtcTimestamp(iso: string | null): string {
  if (!iso) return "\u2014";
  return iso.replace("T", " ").replace(/\.\d+.*$/, " UTC");
}
