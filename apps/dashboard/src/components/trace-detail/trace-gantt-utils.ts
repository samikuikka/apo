import { formatCostMicro, formatDuration, formatTokenTotal } from "@/lib/format";
import { callCacheTokens, type CumulativeMetrics } from "@/lib/cumulative-metrics";
import type { LoggedCall } from "./contexts";
import { getDisplayName as sharedGetDisplayName } from "./trace-display";

export type TimingBounds = { minTs: number; maxTs: number; spanMs: number };

export const TYPE_COLORS: Record<
  string,
  { bar: string; bg: string; text: string; label: string }
> = {
  GENERATION: {
    bar: "bg-type-generation/45",
    bg: "bg-type-generation/15",
    text: "text-type-generation",
    label: "GEN",
  },
  TOOL: {
    bar: "bg-type-tool/45",
    bg: "bg-type-tool/15",
    text: "text-type-tool",
    label: "TOOL",
  },
  AGENT: {
    bar: "bg-type-agent/45",
    bg: "bg-type-agent/15",
    text: "text-type-agent",
    label: "AGENT",
  },
  EMBEDDING: {
    bar: "bg-type-embedding/45",
    bg: "bg-type-embedding/15",
    text: "text-type-embedding",
    label: "EMB",
  },
  RETRIEVER: {
    bar: "bg-type-retriever/45",
    bg: "bg-type-retriever/15",
    text: "text-type-retriever",
    label: "RET",
  },
  SPAN: {
    bar: "bg-foreground/12",
    bg: "bg-muted",
    text: "text-muted-foreground",
    label: "SPAN",
  },
  TRACE: {
    bar: "bg-muted-foreground/25",
    bg: "bg-muted",
    text: "text-muted-foreground",
    label: "TRACE",
  },
};

export function computeTimingBounds(calls: LoggedCall[]): TimingBounds {
  if (calls.length === 0) return { minTs: 0, maxTs: 0, spanMs: 1 };
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const c of calls) {
    const start = new Date(c.created_at).getTime();
    const end = start + (c.latency_ms ?? 0);
    if (start < minTs) minTs = start;
    if (end > maxTs) maxTs = end;
  }
  return { minTs, maxTs, spanMs: maxTs - minTs || 1 };
}

export function getDisplayName(call: LoggedCall): string {
  // Delegate to the shared helper so the gantt agrees with the tree, graph,
  // and detail panel on every observation's label (incl. agent SDK spans).
  return sharedGetDisplayName(call);
}

export interface InlineMetric {
  text: string;
  kind: "duration" | "tokens" | "cost";
}

export function getInlineMetricsStructured(
  call: LoggedCall,
  cumulative?: CumulativeMetrics,
  options?: { showDuration?: boolean; showCostTokens?: boolean },
): InlineMetric[] {
  const showDuration = options?.showDuration ?? true;
  const showCostTokens = options?.showCostTokens ?? true;
  const hasDesc = cumulative && cumulative.descendant_count > 0;
  const dCost = hasDesc && cumulative ? cumulative.cost : (call.cost ?? 0);
  const dTokens =
    hasDesc && cumulative ? cumulative.total_tokens : (call.total_tokens ?? 0);
  const dCacheRead =
    hasDesc && cumulative ? cumulative.cache_read_tokens : callCacheTokens(call).cache_read_tokens;

  const parts: InlineMetric[] = [];
  if (showDuration && call.latency_ms != null) {
    parts.push({ text: formatDuration(call.latency_ms), kind: "duration" });
  }
  if (showCostTokens && dTokens > 0) {
    parts.push({
      text: formatTokenTotal(dTokens, dCacheRead),
      kind: "tokens",
    });
  }
  if (showCostTokens && dCost > 0) {
    parts.push({ text: formatCostMicro(dCost), kind: "cost" });
  }
  return parts;
}
