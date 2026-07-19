"use client";

import { useSelection } from "./contexts/SelectionContext";
import { useTraceData } from "./contexts/TraceDataContext";
import { useViewPreferences } from "./contexts/ViewPreferencesContext";
import type { TraceObservation } from "./contexts";
import { getSemanticType, getEventType } from "./trace-utils";
// getDisplayName / cleanSpanName live in trace-display (shared with gantt +
// graph + detail views) and are re-exported here for existing importers. We
// also import them into local scope — re-export alone doesn't bind the name.
import { getDisplayName, cleanSpanName } from "./trace-display";
export { getDisplayName, cleanSpanName };
import {
  ChevronRight,
  Wrench,
  Boxes,
  BarChart3,
  Search,
  FileText,
  Workflow,
  Fan,
} from "lucide-react";
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import type { CumulativeMetrics } from "@/lib/cumulative-metrics";
import { formatDuration, formatTokenBreakdown, formatTokenTotal } from "@/lib/format";
import { CommentCountIcon } from "./CommentCountIcon";
import { getHeatmapColor } from "./trace-heatmap";

interface TraceTreeProps {
  calls: TraceObservation[];
  searchQuery?: string;
  runLabel?: string;
  commentCounts?: Record<string, number>;
}

interface FlatNode {
  id: string;
  type: "run" | "call";
  call: TraceObservation | null;
  level: number;
  isLastSibling: boolean;
  hasChildren: boolean;
}

interface MetricPart {
  text: string;
  kind: "duration" | "cost" | "tokens" | "model";
  title?: string;
}

const ROW_HEIGHT = 42;
const OVERSCAN = 5;

// Trace type-color tokens (per design.md accent discipline) — hues are
// load-bearing semantic per type; no token exists for blue/emerald/indigo so
// raw Tailwind values are kept (dark value as base, dark: prefix stripped).
const TYPE_CONFIG = {
  TRACE:      { icon: Workflow,  label: "TRACE", barColor: "bg-muted-foreground/30",  color: "text-muted-foreground",   bg: "bg-muted/30" },
  GENERATION: { icon: Fan,       label: "GEN",   barColor: "bg-blue-400/40",          color: "text-blue-400",           bg: "bg-blue-400/10" },
  TOOL:       { icon: Wrench,    label: "TOOL",  barColor: "bg-amber-400/40",         color: "text-amber-400",          bg: "bg-amber-400/10" },
  AGENT:      { icon: Boxes, label: "AGENT", barColor: "bg-emerald-400/40",       color: "text-emerald-400",        bg: "bg-emerald-400/10" },
  EMBEDDING:  { icon: BarChart3, label: "EMB",   barColor: "bg-indigo-400/40",        color: "text-indigo-400",         bg: "bg-indigo-400/10" },
  RETRIEVER:  { icon: Search,    label: "RET",   barColor: "bg-foreground/20",        color: "text-muted-foreground",   bg: "bg-muted/30" },
  SPAN:       { icon: FileText,  label: "SPAN",  barColor: "bg-foreground/20",        color: "text-muted-foreground",   bg: "bg-muted/30" },
} as const;

function computeTimingBounds(calls: TraceObservation[]) {
  if (calls.length === 0) return { minTs: 0, maxTs: 0, spanMs: 1 };
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const c of calls) {
    const start = new Date(c.created_at).getTime();
    const end = start + (c.latency_ms ?? 0);
    if (start < minTs) minTs = start;
    if (end > maxTs) maxTs = end;
  }
  const spanMs = maxTs - minTs || 1;
  return { minTs, maxTs, spanMs };
}

function getChildren(callId: string | null, calls: TraceObservation[]): TraceObservation[] {
  return calls
    .filter((c) => (callId === null ? !c.parent_call_id : c.parent_call_id === callId))
    .sort((a, b) => {
      // Prefer step_index when spans carry it (Langfuse/OTLP traces). Agent-task
      // spans leave it null, so fall back to created_at to preserve the real
      // chronological order — otherwise siblings render in arbitrary array order.
      const ai = a.step_index;
      const bi = b.step_index;
      if (ai != null && bi != null) return ai - bi;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
}

// getDisplayName and cleanSpanName are re-exported from ./trace-display
// (see import near the top of this file). They are shared by the gantt,
// graph, and detail views so every surface agrees on a readable name.

function getModelLabel(model: string | null | undefined): string | null {
  if (!model || model === "unknown") return null;
  const short = model.split("/").at(-1) ?? model;
  return short === "unknown" ? null : short.length > 18 ? `${short.slice(0, 18)}...` : short;
}

function highlightMatch(value: string, searchQuery: string) {
  const query = searchQuery.trim();
  if (!query) {
    return value;
  }

  const lowerValue = value.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const start = lowerValue.indexOf(lowerQuery);
  if (start === -1) {
    return value;
  }

  const end = start + query.length;
  return (
    <>
      {value.slice(0, start)}
      <span className="rounded bg-warning/15 px-0.5 text-foreground">
        {value.slice(start, end)}
      </span>
      {value.slice(end)}
    </>
  );
}

function getRunSummary(calls: TraceObservation[]) {
  const totalDuration = calls.reduce((sum, call) => sum + (call.latency_ms ?? 0), 0);
  const totalTokens = calls.reduce((sum, call) => sum + (call.total_tokens ?? 0), 0);
  const totalCost = calls.reduce((sum, call) => sum + (call.cost ?? 0), 0);

  return {
    duration: totalDuration > 0 ? formatDuration(totalDuration) : null,
    tokens: totalTokens > 0 ? formatTokenTotal(totalTokens) : null,
    cost: totalCost > 0 ? `$${totalCost.toFixed(4)}` : null,
  };
}

function getLevelBadge(level: string | null | undefined): { label: string; colorClass: string } | null {
  const upper = (level ?? "").toUpperCase();
  if (upper === "ERROR") return { label: "ERR", colorClass: "text-destructive bg-destructive/10" };
  if (upper === "WARNING") return { label: "WARN", colorClass: "text-warning bg-warning/10" };
  if (upper === "DEBUG") return { label: "DBG", colorClass: "text-muted-foreground bg-muted/40" };
  return null;
}

interface SpanDisplayOptions {
  showDuration: boolean;
  showCostTokens: boolean;
  showComments: boolean;
  colorCodeMetrics: boolean;
  isSimplifiedTree: boolean;
}

function SpanContent({
  call,
  isRun,
  callCount,
  searchQuery,
  runSummary,
  runLabel,
  timingBounds,
  cumulative,
  totalCost,
  commentCount,
  display,
}: {
  call: TraceObservation | null;
  isRun: boolean;
  callCount: number;
  searchQuery: string;
  runSummary: ReturnType<typeof getRunSummary>;
  runLabel: string;
  timingBounds: ReturnType<typeof computeTimingBounds>;
  cumulative?: CumulativeMetrics | undefined;
  totalCost: number;
  commentCount?: number;
  display: SpanDisplayOptions;
}) {
  const { showDuration, showCostTokens, showComments, colorCodeMetrics, isSimplifiedTree } = display;
  if (isRun) {
    const runParts: MetricPart[] = [
      { text: `${callCount} call${callCount === 1 ? "" : "s"}`, kind: "model" },
      ...(showDuration && runSummary.duration ? [{ text: runSummary.duration, kind: "duration" as const }] : []),
      ...(showCostTokens && runSummary.tokens ? [{ text: runSummary.tokens, kind: "tokens" as const }] : []),
      ...(showCostTokens && runSummary.cost ? [{ text: `\u2211 ${runSummary.cost}`, kind: "cost" as const, title: "Aggregated cost of all child observations" }] : []),
    ];

    return (
      <div className="flex min-w-0 flex-1 items-center gap-2 py-0.5 pr-2 text-left">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <NodeTypeBadge label="TRACE" />
            <span className="truncate text-xs font-medium">{runLabel}</span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1 overflow-hidden text-[11px] text-muted-foreground">
            {runParts.map((part, index) => (
              <span key={`${part.text}-${index}`} className="flex items-center gap-1">
                {index > 0 ? <span className="text-muted-foreground/60">·</span> : null}
                <span className={part.kind !== "model" ? "font-mono" : ""}>
                  {part.text}
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const c = call!;
  const semanticType = getSemanticType(c);
  const latency = formatDuration(c.latency_ms);
  const modelLabel = getModelLabel(c.model);
  const displayName = getDisplayName(c);
  const hasDescendants = cumulative && cumulative.descendant_count > 0;
  const displayCost = hasDescendants && cumulative ? cumulative.cost : (c.cost ?? 0);
  const displayTokens = hasDescendants && cumulative ? cumulative.total_tokens : (c.total_tokens ?? 0);
  const showMetrics = !isSimplifiedTree;
  const levelBadge = getLevelBadge(c.level);
  const metricParts: MetricPart[] = [];
  if (showDuration && showMetrics) metricParts.push({ text: latency, kind: "duration" });
  if (showMetrics && modelLabel) metricParts.push({ text: modelLabel, kind: "model" });
  if (showCostTokens && showMetrics && displayTokens > 0) {
    if (hasDescendants && cumulative && (cumulative.prompt_tokens > 0 || cumulative.completion_tokens > 0)) {
      metricParts.push({ text: formatTokenBreakdown(cumulative.prompt_tokens, cumulative.completion_tokens), kind: "tokens" });
    } else if (!hasDescendants && c.prompt_tokens != null && c.completion_tokens != null) {
      metricParts.push({ text: formatTokenBreakdown(c.prompt_tokens, c.completion_tokens), kind: "tokens" });
    } else {
      metricParts.push({ text: formatTokenTotal(displayTokens), kind: "tokens" });
    }
  }
  if (showCostTokens && showMetrics && displayCost > 0) {
    const prefix = hasDescendants ? "\u2211 " : "";
    metricParts.push({
      text: `${prefix}$${displayCost.toFixed(4)}`,
      kind: "cost",
      title: hasDescendants ? "Aggregated cost of all child observations" : undefined,
    });
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 py-0.5 pr-2 text-left">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <NodeTypeBadge label={TYPE_CONFIG[semanticType].label} color={TYPE_CONFIG[semanticType].color} bg={TYPE_CONFIG[semanticType].bg} />
          <span className="truncate text-xs text-foreground">
            {highlightMatch(displayName, searchQuery)}
          </span>
          {showComments && commentCount != null && commentCount > 0 && (
            <CommentCountIcon count={commentCount} />
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1 overflow-hidden">
          {(metricParts.length > 0 || levelBadge) && (
            <div className="flex min-w-0 flex-wrap items-center gap-1 overflow-hidden text-[11px] text-muted-foreground">
              {levelBadge && (
                <span className={cn("shrink-0 px-1 py-0.5 text-[10px] font-medium", levelBadge.colorClass)}>
                  {levelBadge.label}
                </span>
              )}
              {metricParts.map((part, index) => {
                const colorClass = colorCodeMetrics && part.kind === "duration"
                  ? getHeatmapColor(c.latency_ms ?? 0, timingBounds.spanMs)
                  : colorCodeMetrics && part.kind === "cost"
                    ? getHeatmapColor(displayCost, totalCost)
                    : undefined;
                return (
                  <span key={part.text} className="flex shrink-0 items-center gap-1">
                    {index > 0 || levelBadge ? <span className="text-muted-foreground/60">·</span> : null}
                    {part.kind === "model" ? (
                      <span className="max-w-[90px] truncate" title={part.title}>
                        {highlightMatch(part.text, searchQuery)}
                      </span>
                    ) : (
                      <span className={cn("font-mono", colorClass)} title={part.title}>
                        {part.text}
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const PREFETCH_DELAY_MS = 250;

function TreeNode({
  node,
  calls,
  isExpanded,
  onToggle,
  treeLines,
  searchQuery,
  runLabel,
  timingBounds,
  cumulative,
  totalCost,
  commentCounts,
  prefetchObservation,
  display,
}: {
  node: FlatNode;
  calls: TraceObservation[];
  isExpanded: boolean;
  onToggle: () => void;
  treeLines: boolean[];
  searchQuery: string;
  runLabel: string;
  timingBounds: ReturnType<typeof computeTimingBounds>;
  cumulative?: CumulativeMetrics | undefined;
  totalCost: number;
  commentCounts?: Record<string, number>;
  prefetchObservation: (callId: string) => void;
  display: SpanDisplayOptions;
}) {
  const { selectCall, selectedCallId } = useSelection();
  const isSelected = node.call ? selectedCallId === node.call.id : !selectedCallId;
  const isRun = node.type === "run";
  const semanticType = isRun ? "TRACE" : getSemanticType(node.call);
  const Icon = TYPE_CONFIG[semanticType].icon;
  const runSummary = getRunSummary(calls);
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = useCallback(() => {
    if (!node.call) return;
    prefetchTimerRef.current = setTimeout(() => {
      prefetchObservation(node.call!.id);
    }, PREFETCH_DELAY_MS);
  }, [node.call, prefetchObservation]);

  const handleMouseLeave = useCallback(() => {
    if (prefetchTimerRef.current) {
      clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = null;
    }
  }, []);

  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectCall(node.call?.id ?? null); } }}
      className={cn(
        "relative flex w-full cursor-pointer border-l border-transparent px-0 py-px text-left bg-transparent",
        isSelected ? "border-l-foreground/40 bg-muted/30" : "hover:bg-muted/15",
      )}
      onClick={() => selectCall(node.call?.id ?? null)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="flex w-full pl-2">
        {node.level > 1 && (
          <div className="flex shrink-0">
            {Array.from({ length: node.level - 1 }, (_, i) => (
              <div key={i} className="relative w-4">
                {treeLines[i] && (
                  <div className="absolute bottom-0 left-2.5 top-0 w-px bg-border/40" />
                )}
              </div>
            ))}
          </div>
        )}

        {node.level > 0 && (
          <div className="relative w-4 shrink-0">
            <div className={cn("absolute left-2.5 top-0 w-px bg-border/40", node.isLastSibling ? "h-3.5" : "bottom-3.5")} />
            {!node.isLastSibling && (
              <div className="absolute bottom-0 left-2.5 top-3.5 w-px bg-border/40" />
            )}
            <div className="absolute left-2.5 top-3.5 h-px w-1.5 bg-border/40" />
          </div>
        )}

        <div className="flex w-5 shrink-0 items-center justify-center">
          {node.hasChildren ? (
            <button
              type="button"
              data-expand-button
              aria-label={isExpanded ? "Collapse node" : "Expand node"}
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
              className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              <span className={cn("inline-block h-4 w-4 transition-transform duration-200", isExpanded ? "rotate-90" : "rotate-0")}>
                <ChevronRight className="h-4 w-4" />
              </span>
            </button>
          ) : null}
        </div>

        <div className="flex w-5 shrink-0 items-start justify-center pt-1.5">
          <div className={`flex h-4 w-4 items-center justify-center ${TYPE_CONFIG[semanticType].bg} ${TYPE_CONFIG[semanticType].color}`}>
            <Icon className="h-[10px] w-[10px]" />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 py-1">
          <SpanContent
            call={node.call}
            isRun={isRun}
            callCount={calls.length}
            searchQuery={searchQuery}
            runSummary={runSummary}
            runLabel={runLabel}
            timingBounds={timingBounds}
            cumulative={cumulative}
            totalCost={totalCost}
            commentCount={node.call ? (commentCounts?.[node.call.id] ?? 0) : undefined}
            display={display}
          />
        </div>
      </div>
    </div>
  );
}

function flattenTree(
  calls: TraceObservation[],
  expanded: Set<string>,
  searchQuery: string,
): Array<{ node: FlatNode; treeLines: boolean[] }> {
  const result: Array<{ node: FlatNode; treeLines: boolean[] }> = [];
  const matchingIds = getMatchingIds(calls, searchQuery);
  const isSearch = searchQuery.trim().length > 0;
  const runId = "root-run";
  const rootCalls = getVisibleChildren(null, calls, matchingIds);

  result.push({
    node: { id: runId, type: "run", call: null, level: 0, isLastSibling: true, hasChildren: rootCalls.length > 0 },
    treeLines: [],
  });

  if ((expanded.has(runId) || isSearch) && rootCalls.length > 0) {
    function traverse(call: TraceObservation, level: number, isLast: boolean, lines: boolean[]) {
      const children = getVisibleChildren(call.id, calls, matchingIds);
      result.push({
        node: { id: call.id, type: "call", call, level, isLastSibling: isLast, hasChildren: children.length > 0 },
        treeLines: [...lines, !isLast],
      });
      if ((expanded.has(call.id) || isSearch) && children.length > 0) {
        children.forEach((child, i) => traverse(child, level + 1, i === children.length - 1, [...lines, !isLast]));
      }
    }
    rootCalls.forEach((call, i) => traverse(call, 1, i === rootCalls.length - 1, []));
  }

  return result;
}

function getVisibleChildren(callId: string | null, calls: TraceObservation[], matchingIds: Set<string> | null) {
  const children = getChildren(callId, calls);
  return matchingIds ? children.filter((c) => matchingIds.has(c.id)) : children;
}

function getMatchingIds(calls: TraceObservation[], searchQuery: string): Set<string> | null {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return null;
  const byId = new Map(calls.map((c) => [c.id, c]));
  const included = new Set<string>();
  for (const call of calls) {
    if (!matchesCall(call, q)) continue;
    let cur: TraceObservation | undefined = call;
    while (cur) {
      included.add(cur.id);
      cur = cur.parent_call_id ? byId.get(cur.parent_call_id) : undefined;
    }
  }
  return included;
}

function matchesCall(call: TraceObservation, q: string) {
  return [call.step_name, call.call_type, call.model, call.tool_name, getEventType(call), getDisplayName(call)].some(
    (v) => typeof v === "string" && v.toLowerCase().includes(q),
  );
}

export function TraceTree({
  calls,
  searchQuery = "",
  runLabel = "Trace",
  commentCounts,
}: TraceTreeProps) {
  const { selectCall, selectedCallId } = useSelection();
  const { cumulativeMetrics, prefetchObservation, isSimplifiedTree } = useTraceData();
  const { preferences } = useViewPreferences();
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>(["root-run"]);
    calls.forEach((c) => s.add(c.id));
    return s;
  });

  const toggleNode = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  };

  const flatTree = useMemo(() => flattenTree(calls, expanded, searchQuery), [calls, expanded, searchQuery]);
  const timingBounds = useMemo(() => computeTimingBounds(calls), [calls]);
  const totalCost = useMemo(() => calls.reduce((sum, c) => sum + (c.cost ?? 0), 0), [calls]);

  const levelCounts = useMemo(() => {
    const counts = { all: 0, error: 0, warning: 0, debug: 0 };
    for (const { node } of flatTree) {
      if (!node.call) continue;
      counts.all++;
      const level = (node.call.level ?? "").toUpperCase();
      if (level === "ERROR") counts.error++;
      else if (level === "WARNING") counts.warning++;
      else if (level === "DEBUG") counts.debug++;
    }
    return counts;
  }, [flatTree]);

  const filteredTree = useMemo(() => {
    const callsById = new Map(calls.map((c) => [c.id, c]));
    let tree = flatTree;

    if (levelFilter !== "all") {
      const levelUpper = levelFilter.toUpperCase();
      const matchingIds = new Set<string>();
      for (const { node } of tree) {
        if (node.call && (node.call.level ?? "").toUpperCase() === levelUpper) {
          matchingIds.add(node.id);
          let parentId = node.call.parent_call_id;
          while (parentId) {
            matchingIds.add(parentId);
            const parent = callsById.get(parentId);
            parentId = parent?.parent_call_id ?? null;
          }
        }
      }
      matchingIds.add("root-run");
      tree = tree.filter(({ node }) => matchingIds.has(node.id));
    }

    if (preferences.minObservationLevel !== "DEFAULT") {
      const minLevels: Record<string, Set<string>> = {
        DEBUG: new Set(["DEBUG", "WARNING", "ERROR"]),
        WARNING: new Set(["WARNING", "ERROR"]),
        ERROR: new Set(["ERROR"]),
      };
      const allowed = minLevels[preferences.minObservationLevel];
      if (allowed) {
        const matchingIds = new Set<string>();
        for (const { node } of tree) {
          if (node.call && allowed.has((node.call.level ?? "").toUpperCase())) {
            matchingIds.add(node.id);
            let parentId = node.call.parent_call_id;
            while (parentId) {
              matchingIds.add(parentId);
              const parent = callsById.get(parentId);
              parentId = parent?.parent_call_id ?? null;
            }
          }
        }
        matchingIds.add("root-run");
        tree = tree.filter(({ node }) => matchingIds.has(node.id));
      }
    }

    return tree;
  }, [flatTree, levelFilter, calls, preferences.minObservationLevel]);

  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: filteredTree.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: OVERSCAN,
  });

  const hasScrolledToSelected = useRef(false);
  useEffect(() => {
    if (!selectedCallId || hasScrolledToSelected.current) return;
    const idx = filteredTree.findIndex(
      ({ node }) => node.call && node.call.id === selectedCallId,
    );
    if (idx !== -1) {
      virtualizer.scrollToIndex(idx, { align: "center" });
      hasScrolledToSelected.current = true;
    }
  }, [selectedCallId, filteredTree, virtualizer]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const idx = filteredTree.findIndex(n => n.node.call?.id === selectedCallId);
        const next = filteredTree[Math.min(idx + 1, filteredTree.length - 1)];
        if (next) selectCall(next.node.call?.id ?? null);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const idx = filteredTree.findIndex(n => n.node.call?.id === selectedCallId);
        if (idx > 0) selectCall(filteredTree[idx - 1].node.call?.id ?? null);
      } else if (e.key === "Escape") {
        selectCall(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [filteredTree, selectedCallId, selectCall]);

  if (calls.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">No calls in this trace.</p>
      </div>
    );
  }

  if (searchQuery.trim() && filteredTree.length <= 1) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">No matching spans.</p>
      </div>
    );
  }

  const LEVEL_OPTIONS = [
    { key: "all", label: "All", count: levelCounts.all, dotClass: "" },
    { key: "error", label: "Errors", count: levelCounts.error, dotClass: "bg-destructive" },
    { key: "warning", label: "Warnings", count: levelCounts.warning, dotClass: "bg-warning" },
    { key: "debug", label: "Debug", count: levelCounts.debug, dotClass: "bg-muted-foreground" },
  ] as const;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2.5 py-1.5">
        {LEVEL_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            type="button"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] transition-colors",
              levelFilter === opt.key
                ? "bg-primary/10 text-primary font-medium"
                : opt.count === 0
                  ? "text-muted-foreground/40 cursor-default"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
            onClick={() => setLevelFilter(opt.key)}
            disabled={opt.count === 0 && opt.key !== "all"}
          >
            {opt.dotClass && (
              <span className={cn("inline-block h-1.5 w-1.5 rounded-full", opt.dotClass)} />
            )}
            {opt.label}
            <span className="tabular-nums text-muted-foreground/60">{opt.count}</span>
          </button>
        ))}
      </div>
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const { node, treeLines } = filteredTree[virtualRow.index];
          return (
            <div
              key={node.id}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              style={{
                position: "absolute",
                top: virtualRow.start,
                left: 0,
                width: "100%",
              }}
            >
              <TreeNode
                node={node}
                calls={calls}
                isExpanded={expanded.has(node.id)}
                onToggle={() => toggleNode(node.id)}
                treeLines={treeLines}
                searchQuery={searchQuery}
                runLabel={runLabel}
                timingBounds={timingBounds}
                cumulative={node.call ? cumulativeMetrics.get(node.call.id) : undefined}
                totalCost={totalCost}
                commentCounts={commentCounts}
                prefetchObservation={prefetchObservation}
                display={{
                  showDuration: preferences.showDuration,
                  showCostTokens: preferences.showCostTokens,
                  showComments: preferences.showComments,
                  colorCodeMetrics: preferences.colorCodeMetrics,
                  isSimplifiedTree,
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
    </div>
  );
}

function NodeTypeBadge({ label, color, bg }: { label: string; color?: string; bg?: string }) {
  return (
    <span className={`inline-flex items-center border border-current/20 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide ${color ?? "text-muted-foreground"} ${bg ?? "bg-muted/10"}`}>
      {label}
    </span>
  );
}
