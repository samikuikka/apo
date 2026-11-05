import type { LoggedCall } from "@/components/trace-detail";

export interface CumulativeMetrics {
  cost: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Uncached prompt tokens up the tree: `raw_usage.input` where normalized
   * usage exists, the `prompt_tokens` column otherwise. */
  prompt_uncached_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  latency_ms: number;
  descendant_count: number;
}

export interface CallCacheTokens {
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** The prompt's uncached part; `raw_usage.input` is normalized net of cache
   * on every provider, unlike the `prompt_tokens` column, which stores each
   * provider's own convention (net for direct Anthropic spans, gross
   * elsewhere). Null when the call has no normalized usage. */
  input_uncached: number | null;
}

export function callCacheTokens(call: Pick<LoggedCall, "raw_usage">): CallCacheTokens {
  const usage = call.raw_usage ?? {};
  return {
    cache_read_tokens: usage.cache_read ?? 0,
    cache_write_tokens: (usage.cache_write_5m ?? 0) + (usage.cache_write_1h ?? 0),
    input_uncached: usage.input ?? null,
  };
}

/** The whole prompt a cache split can annotate: the uncached part plus both
 * cache parts. Falls back to the `prompt_tokens` column when the call carries
 * no normalized usage (its cache parts read as zero there). */
export function wholePromptTokens(
  call: Pick<LoggedCall, "raw_usage" | "prompt_tokens">,
): number | null {
  const cache = callCacheTokens(call);
  if (cache.input_uncached == null) return call.prompt_tokens ?? null;
  return cache.input_uncached + cache.cache_read_tokens + cache.cache_write_tokens;
}

export function computeCumulativeMetrics(
  calls: LoggedCall[],
): Map<string, CumulativeMetrics> {
  const result = new Map<string, CumulativeMetrics>();
  const byId = new Map(calls.map((c) => [c.id, c]));
  const childrenMap = new Map<string | null, LoggedCall[]>();

  for (const call of calls) {
    const parentId = call.parent_call_id ?? null;
    const siblings = childrenMap.get(parentId) ?? [];
    siblings.push(call);
    childrenMap.set(parentId, siblings);
  }

  function accumulate(callId: string): CumulativeMetrics {
    if (result.has(callId)) return result.get(callId)!;

    const call = byId.get(callId)!;
    const children = childrenMap.get(callId) ?? [];

    let childTotals: CumulativeMetrics = {
      cost: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_uncached_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      latency_ms: 0,
      descendant_count: 0,
    };

    for (const child of children) {
      const childCum = accumulate(child.id);
      childTotals.cost += childCum.cost;
      childTotals.prompt_tokens += childCum.prompt_tokens;
      childTotals.completion_tokens += childCum.completion_tokens;
      childTotals.total_tokens += childCum.total_tokens;
      childTotals.prompt_uncached_tokens += childCum.prompt_uncached_tokens;
      childTotals.cache_read_tokens += childCum.cache_read_tokens;
      childTotals.cache_write_tokens += childCum.cache_write_tokens;
      childTotals.latency_ms = Math.max(childTotals.latency_ms, childCum.latency_ms);
      childTotals.descendant_count += childCum.descendant_count + 1;
    }

    const own = callCacheTokens(call);
    const cumulative: CumulativeMetrics = {
      cost: (call.cost ?? 0) + childTotals.cost,
      prompt_tokens: (call.prompt_tokens ?? 0) + childTotals.prompt_tokens,
      completion_tokens: (call.completion_tokens ?? 0) + childTotals.completion_tokens,
      total_tokens: (call.total_tokens ?? 0) + childTotals.total_tokens,
      prompt_uncached_tokens:
        (own.input_uncached ?? call.prompt_tokens ?? 0) + childTotals.prompt_uncached_tokens,
      cache_read_tokens: own.cache_read_tokens + childTotals.cache_read_tokens,
      cache_write_tokens: own.cache_write_tokens + childTotals.cache_write_tokens,
      latency_ms: Math.max(call.latency_ms ?? 0, childTotals.latency_ms),
      descendant_count: childTotals.descendant_count,
    };

    result.set(callId, cumulative);
    return cumulative;
  }

  const roots = childrenMap.get(null) ?? [];
  for (const root of roots) {
    accumulate(root.id);
  }

  for (const call of calls) {
    if (!result.has(call.id)) {
      result.set(call.id, {
        cost: call.cost ?? 0,
        prompt_tokens: call.prompt_tokens ?? 0,
        completion_tokens: call.completion_tokens ?? 0,
        total_tokens: call.total_tokens ?? 0,
        prompt_uncached_tokens: callCacheTokens(call).input_uncached ?? call.prompt_tokens ?? 0,
        ...callCacheTokens(call),
        latency_ms: call.latency_ms ?? 0,
        descendant_count: 0,
      });
    }
  }

  return result;
}
