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
