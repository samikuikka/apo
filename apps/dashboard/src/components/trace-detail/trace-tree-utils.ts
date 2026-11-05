import type { TraceObservation } from "./contexts";
import { callCacheTokens } from "@/lib/cumulative-metrics";
import { formatCostMicro, formatDuration, formatInputCacheSplit, formatTokenTotal } from "@/lib/format";

/** Aggregated duration / tokens / cost for a whole run (the TraceTree root row). */
export function getRunSummary(calls: TraceObservation[]) {
  const totalDuration = calls.reduce((sum, call) => sum + (call.latency_ms ?? 0), 0);
  const totalTokens = calls.reduce((sum, call) => sum + (call.total_tokens ?? 0), 0);
  const totalCost = calls.reduce((sum, call) => sum + (call.cost ?? 0), 0);
  const cache = sumCacheTokens(calls);

  return {
    duration: totalDuration > 0 ? formatDuration(totalDuration) : null,
    tokens: totalTokens > 0 ? formatTokenTotal(totalTokens, cache.read) : null,
    tokensTitle: formatInputCacheSplit(cache.uncached, cache.read, cache.write),
    cost: totalCost > 0 ? formatCostMicro(totalCost) : null,
  };
}

export interface CacheTokenSums {
  /** Uncached prompt tokens: `raw_usage.input` where normalized usage exists,
   * the `prompt_tokens` column otherwise. */
  uncached: number;
  read: number;
  write: number;
}

export function sumCacheTokens(calls: TraceObservation[]): CacheTokenSums {
  return calls.reduce(
    (sum, call) => {
      const cache = callCacheTokens(call);
      return {
        uncached: sum.uncached + (cache.input_uncached ?? call.prompt_tokens ?? 0),
        read: sum.read + cache.cache_read_tokens,
        write: sum.write + cache.cache_write_tokens,
      };
    },
    { uncached: 0, read: 0, write: 0 },
  );
}

export interface TraceChildrenIndex {
  byId: Map<string, TraceObservation>;
  /** Children per parent id (null key = roots), each list in sibling order.
   * Built once per calls array so tree/timeline flattening never rescans and
   * re-sorts every span per node. */
  childrenByParent: Map<string | null, TraceObservation[]>;
  /** created_at as epoch ms per call id, parsed once. Sorting and timing
   * math read these instead of re-parsing ISO strings in every comparator. */
  startMsById: Map<string, number>;
}

/** Sibling order shared by the tree and timeline views: step_index when both
 * siblings carry it, chronological order otherwise (agent-task spans leave
 * step_index null). */
export function compareSiblings(
  a: TraceObservation,
  b: TraceObservation,
  startMsById: Map<string, number>,
): number {
  if (a.step_index != null && b.step_index != null) return a.step_index - b.step_index;
  const sa = startMsById.get(a.id) ?? 0;
  const sb = startMsById.get(b.id) ?? 0;
  return sa - sb;
}

export function buildTraceChildrenIndex(calls: TraceObservation[]): TraceChildrenIndex {
  const byId = new Map<string, TraceObservation>();
  const startMsById = new Map<string, number>();
  const childrenByParent = new Map<string | null, TraceObservation[]>();

  for (const call of calls) {
    byId.set(call.id, call);
    startMsById.set(call.id, new Date(call.created_at).getTime());
    const key = call.parent_call_id ?? null;
    const siblings = childrenByParent.get(key);
    if (siblings) siblings.push(call);
    else childrenByParent.set(key, [call]);
  }

  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => compareSiblings(a, b, startMsById));
  }

  return { byId, childrenByParent, startMsById };
}
