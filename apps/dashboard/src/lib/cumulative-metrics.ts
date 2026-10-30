import type { LoggedCall } from "@/components/trace-detail";

export interface CumulativeMetrics {
  cost: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Prompt-cache reads and writes, both included in `prompt_tokens`. */
  cache_read_tokens: number;
  cache_write_tokens: number;
  latency_ms: number;
  descendant_count: number;
}

export function callCacheTokens(call: Pick<LoggedCall, "raw_usage">): {
  cache_read_tokens: number;
  cache_write_tokens: number;
} {
  const usage = call.raw_usage ?? {};
  return {
    cache_read_tokens: usage.cache_read ?? 0,
    cache_write_tokens: (usage.cache_write_5m ?? 0) + (usage.cache_write_1h ?? 0),
  };
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
        ...callCacheTokens(call),
        latency_ms: call.latency_ms ?? 0,
        descendant_count: 0,
      });
    }
  }

  return result;
}
