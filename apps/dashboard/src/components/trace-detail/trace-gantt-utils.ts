import { formatDuration, formatTokenTotal } from "@/lib/format";
import type { CumulativeMetrics } from "@/lib/cumulative-metrics";
import type { LoggedCall } from "./contexts";
import { getSemanticType } from "./trace-utils";
import { getDisplayName as sharedGetDisplayName } from "./trace-display";

export const MIN_BAR_WIDTH_PX = 2;
export const TARGET_TICKS = 8;

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

export function getChildren(callId: string | null, calls: LoggedCall[]): LoggedCall[] {
  return calls
    .filter((c) => (callId === null ? !c.parent_call_id : c.parent_call_id === callId))
    .sort((a, b) => {
      // Fall back to created_at when step_index is absent (agent-task spans),
      // so siblings render in true chronological order, not array order.
      const ai = a.step_index;
      const bi = b.step_index;
      if (ai != null && bi != null) return ai - bi;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
}

export interface FlatGanttNode {
  id: string;
  call: LoggedCall | null;
  depth: number;
  hasChildren: boolean;
}

export function flattenGanttTree(
  calls: LoggedCall[],
  expanded: Set<string>,
  searchQuery: string,
): FlatGanttNode[] {
  const result: FlatGanttNode[] = [];
  const matchingIds = getMatchingIds(calls, searchQuery);
  const isSearch = searchQuery.trim().length > 0;
  const rootCalls = getVisibleChildren(null, calls, matchingIds);

  result.push({
    id: "root-run",
    call: null,
    depth: 0,
    hasChildren: rootCalls.length > 0,
  });

  if ((expanded.has("root-run") || isSearch) && rootCalls.length > 0) {
    function traverse(call: LoggedCall, depth: number) {
      const children = getVisibleChildren(call.id, calls, matchingIds);
      result.push({
        id: call.id,
        call,
        depth,
        hasChildren: children.length > 0,
      });
      if ((expanded.has(call.id) || isSearch) && children.length > 0) {
        children.forEach((child) => traverse(child, depth + 1));
      }
    }
    rootCalls.forEach((call) => traverse(call, 1));
  }

  return result;
}

function getVisibleChildren(
  callId: string | null,
  calls: LoggedCall[],
  matchingIds: Set<string> | null,
) {
  const children = getChildren(callId, calls);
  return matchingIds ? children.filter((c) => matchingIds.has(c.id)) : children;
}

function getMatchingIds(
  calls: LoggedCall[],
  searchQuery: string,
): Set<string> | null {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return null;
  const byId = new Map(calls.map((c) => [c.id, c]));
  const included = new Set<string>();
  for (const call of calls) {
    if (!matchesCall(call, q)) continue;
    let cur: LoggedCall | undefined = call;
    while (cur) {
      included.add(cur.id);
      cur = cur.parent_call_id ? byId.get(cur.parent_call_id) : undefined;
    }
  }
  return included;
}

function matchesCall(call: LoggedCall, q: string) {
  return [call.step_name, call.call_type, call.model, call.tool_name].some(
    (v) => typeof v === "string" && v.toLowerCase().includes(q),
  );
}

export function barPosition(
  call: LoggedCall,
  bounds: TimingBounds,
  zoom: number,
): { left: number; width: number } | null {
  if (call.latency_ms == null) return null;
  const start = new Date(call.created_at).getTime();
  const end = start + call.latency_ms;
  const cw = bounds.spanMs * zoom;
  return {
    left: Math.max(0, ((start - bounds.minTs) / bounds.spanMs) * cw),
    width: Math.max(((end - start) / bounds.spanMs) * cw, MIN_BAR_WIDTH_PX),
  };
}

export function fmtRuler(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const min = Math.floor(totalSec / 60);
  const sec = Math.round((totalSec % 60) * 10) / 10;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

export function tickInterval(spanMs: number, zoom: number): number {
  const visible = spanMs / zoom;
  const rough = visible / TARGET_TICKS;
  const nice = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];
  for (const n of nice) {
    if (n >= rough) return n;
  }
  return Math.ceil(rough / 60000) * 60000;
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

  const parts: InlineMetric[] = [];
  if (showDuration && call.latency_ms != null) {
    parts.push({ text: formatDuration(call.latency_ms), kind: "duration" });
  }
  if (showCostTokens && dTokens > 0) {
    parts.push({
      text: formatTokenTotal(dTokens),
      kind: "tokens",
    });
  }
  if (showCostTokens && dCost > 0) {
    parts.push({ text: `$${dCost.toFixed(dCost < 0.01 ? 6 : 4)}`, kind: "cost" });
  }
  return parts;
}

export function getInlineMetrics(
  call: LoggedCall,
  cumulative?: CumulativeMetrics,
  options?: { showDuration?: boolean; showCostTokens?: boolean },
): string[] {
  return getInlineMetricsStructured(call, cumulative, options).map((m) => m.text);
}

export function getTypeLabel(call: LoggedCall | null): string {
  const semType = call ? getSemanticType(call) : "TRACE";
  return TYPE_COLORS[semType]?.label ?? "SPAN";
}
