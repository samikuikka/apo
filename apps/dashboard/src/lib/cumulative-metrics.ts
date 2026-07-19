import type { LoggedCall } from "@/components/trace-detail";

export interface CumulativeMetrics {
  cost: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  latency_ms: number;
  descendant_count: number;
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
      latency_ms: 0,
      descendant_count: 0,
    };

    for (const child of children) {
      const childCum = accumulate(child.id);
      childTotals.cost += childCum.cost;
      childTotals.prompt_tokens += childCum.prompt_tokens;
      childTotals.completion_tokens += childCum.completion_tokens;
      childTotals.total_tokens += childCum.total_tokens;
      childTotals.latency_ms = Math.max(childTotals.latency_ms, childCum.latency_ms);
      childTotals.descendant_count += childCum.descendant_count + 1;
    }

    const cumulative: CumulativeMetrics = {
      cost: (call.cost ?? 0) + childTotals.cost,
      prompt_tokens: (call.prompt_tokens ?? 0) + childTotals.prompt_tokens,
      completion_tokens: (call.completion_tokens ?? 0) + childTotals.completion_tokens,
      total_tokens: (call.total_tokens ?? 0) + childTotals.total_tokens,
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
        latency_ms: call.latency_ms ?? 0,
        descendant_count: 0,
      });
    }
  }

  return result;
}
