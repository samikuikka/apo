"use client";

import { useSelection } from "./contexts/SelectionContext";
import { useTraceData } from "./contexts/TraceDataContext";
import { useViewPreferences } from "./contexts/ViewPreferencesContext";
import type { TraceObservation } from "./contexts";
import { getCallDetail } from "@/lib/traces-api";
import {
  findEvaluationGroup,
  isEvaluationRoot,
  parseVerdict,
  partitionEvaluation,
} from "./trace-evaluation";
import { getSemanticType, getEventType } from "./trace-utils";
// getDisplayName lives in trace-display (shared with gantt + graph + detail
// views) and is imported here for local use; import it directly from
// ./trace-display. getRunSummary lives in ./trace-tree-utils.
import { getDisplayName } from "./trace-display";
import { getRunSummary } from "./trace-tree-utils";
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Wrench,
  Boxes,
  BarChart3,
  Search,
  FileText,
  Workflow,
  Fan,
  Scale,
} from "lucide-react";
import { useState, useMemo, useRef, useEffect, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import type { CumulativeMetrics } from "@/lib/cumulative-metrics";
import { formatCostMicro, formatDuration, formatTokenBreakdown, formatTokenTotal } from "@/lib/format";
import { CommentCountIcon } from "./CommentCountIcon";
import { getHeatmapColor } from "./trace-heatmap";

// ── Evaluation phase (#302): judge roots (judge:* / t.agent:*) and their
// descendants collapse into one "Evaluation" row with pass/fail counts.
// Grouping lives in ./trace-evaluation (pure, tested); searching suspends it
// so matching judge rows surface like any other row.

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

const ROW_HEIGHT = 37;
const OVERSCAN = 5;

// Virtualizer config callbacks that close over nothing — hoisted so they hold
// a stable identity across renders.
const estimateRowSize = () => ROW_HEIGHT;
const measureRowElement = (el: Element) => el.getBoundingClientRect().height;

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

// getDisplayName and cleanSpanName live in ./trace-display and getRunSummary
// in ./trace-tree-utils (see imports above). They are shared by the gantt,
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
      text: `${prefix}${formatCostMicro(displayCost)}`,
      kind: "cost",
      title: hasDescendants ? "Aggregated cost of all child observations" : undefined,
    });
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 py-0.5 pr-2 text-left">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-xs text-foreground">
            {highlightMatch(displayName, searchQuery)}
          </span>
          {showComments && commentCount != null && commentCount > 0 && (
            <CommentCountIcon count={commentCount} />
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 overflow-hidden">
          {(metricParts.length > 0 || levelBadge) && (
            <>
              {levelBadge && (
                <span className={cn("text-xs font-medium", levelBadge.colorClass)}>
                  {levelBadge.label}
                </span>
              )}
              {metricParts.map((part) => {
                const colorClass = colorCodeMetrics && part.kind === "duration"
                  ? getHeatmapColor(c.latency_ms ?? 0, timingBounds.spanMs)
                  : colorCodeMetrics && part.kind === "cost"
                    ? getHeatmapColor(displayCost, totalCost)
                    : undefined;
                return (
                  <span key={part.text} className={cn("text-xs text-muted-foreground", colorClass)} title={part.title}>
                    {part.text}
                  </span>
                );
              })}
            </>
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
  onToggle: (id: string) => void;
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

  const handleExpandClick = useCallback(
    (e: ReactMouseEvent) => {
      e.stopPropagation();
      onToggle(node.id);
    },
    [onToggle, node.id],
  );

  const handleSelectClick = useCallback(() => {
    selectCall(node.call?.id ?? null);
  }, [selectCall, node.call?.id]);

  return (
    <div
      className={cn(
        "relative flex w-full border-l border-transparent px-0 py-px text-left bg-transparent",
        isSelected ? "border-l-foreground/40 bg-muted/30" : "hover:bg-muted/15",
      )}
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
              onClick={handleExpandClick}
              className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              <span className={cn("inline-block h-4 w-4 transition-transform duration-200", isExpanded ? "rotate-90" : "rotate-0")}>
                <ChevronRight className="h-4 w-4" />
              </span>
            </button>
          ) : null}
        </div>

        <button
          type="button"
          onClick={handleSelectClick}
          className="flex min-w-0 flex-1 cursor-pointer bg-transparent text-left"
        >
          <div className="flex w-5 shrink-0 items-start justify-center pt-1">
            <div title={TYPE_CONFIG[semanticType].label} className={`flex h-3.5 w-3.5 items-center justify-center ${TYPE_CONFIG[semanticType].bg} ${TYPE_CONFIG[semanticType].color}`}>
              <Icon className="h-[9px] w-[9px]" />
            </div>
          </div>

          <div className="flex min-w-0 flex-1 py-0.5">
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
        </button>
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
  // The evaluation phase collapses by default; the chevron on the group row
  // expands it in place.
  const [evalExpanded, setEvalExpanded] = useState(false);
  const evaluation = useMemo(() => findEvaluationGroup(calls), [calls]);
  const judgeRoots = evaluation?.roots ?? [];

  const { selectCall, selectedCallId } = useSelection();
  const { run, cumulativeMetrics, prefetchObservation, isSimplifiedTree } = useTraceData();
  const { preferences } = useViewPreferences();
  const [levelFilter, setLevelFilter] = useState<string>("all");
  // PROTOTYPE: verdict map keyed by judge root id. The slim payload carries
  // no tool_result, so each judge root's full call is fetched once (they are
  // few per run) to color the pass/fail badges and the Evaluation counts.
  const [judgeVerdicts, setJudgeVerdicts] = useState<Record<string, boolean | undefined>>({});
  useEffect(() => {
    const trace = run?.run;
    if (!trace || judgeRoots.length === 0) return;
    const missing = judgeRoots.filter((j) => !(j.id in judgeVerdicts));
    if (missing.length === 0) return;
    const controller = new AbortController();
    let active = true;
    Promise.all(
      missing.map((j) =>
        getCallDetail(trace.id, j.id, trace.project, controller.signal)
          .then((full) => [j.id, parseVerdict(full.tool_result)] as const)
          .catch(() => [j.id, undefined] as const),
      ),
    ).then((pairs) => {
      if (!active) return;
      setJudgeVerdicts((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [run, judgeRoots, judgeVerdicts]);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>(["root-run"]);
    calls.forEach((c) => s.add(c.id));
    return s;
  });

  const toggleNode = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }, []);

  const allExpanded = expanded.size >= calls.length + 1;
  const toggleAll = useCallback(() => {
    if (allExpanded) {
      setExpanded(new Set(["root-run"]));
    } else {
      setExpanded(new Set(["root-run", ...calls.map((c) => c.id)]));
    }
  }, [allExpanded, calls]);

  const flatTree = useMemo(() => {
    const tree = flattenTree(calls, expanded, searchQuery);
    // Search suspends grouping: matching judge rows surface like any other row.
    if (!evaluation || searchQuery.trim().length > 0) return tree;
    const split = partitionEvaluation(tree, evaluation);
    if (!split) return tree;
    const judgeSubtree = tree.filter(
      (n) => n.node.call !== null && evaluation.memberIds.has(n.node.call.id),
    );
    return [
      ...split.kept.slice(0, split.insertAt),
      {
        node: { id: "evaluation-group", type: "call" as const, call: judgeRoots[0], level: 1, isLastSibling: true, hasChildren: true },
        treeLines: [],
        isEvalGroup: true,
        evalOpen: evalExpanded,
        evalPassed: judgeRoots.filter((j) => judgeVerdicts[j.id] === true).length,
        evalFailed: judgeRoots.filter((j) => judgeVerdicts[j.id] === false).length,
      },
      ...(evalExpanded ? judgeSubtree : []),
      ...split.kept.slice(split.insertAt),
    ];
  }, [calls, expanded, searchQuery, evaluation, judgeRoots, evalExpanded, judgeVerdicts]);
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
  const getScrollElement = useCallback(() => parentRef.current, []);

  const virtualizer = useVirtualizer({
    count: filteredTree.length,
    getScrollElement,
    estimateSize: estimateRowSize,
    measureElement: measureRowElement,
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
        <button
          type="button"
          onClick={toggleAll}
          className="ml-auto flex items-center text-muted-foreground hover:text-foreground"
          title={allExpanded ? "Collapse all" : "Expand all"}
        >
          {allExpanded ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
        </button>
      </div>
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = filteredTree[virtualRow.index];
          const { node, treeLines } = row;
          // The synthetic group row carries judgeRoots[0] as its call (so
          // keyboard nav can select it) — it must be matched BEFORE the
          // judge-row branch below, or it renders as a plain judge row.
          if ("isEvalGroup" in row && row.isEvalGroup) {
            return (
              <div
                key={node.id}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                style={{ position: "absolute", top: virtualRow.start, left: 0, width: "100%" }}
              >
                <div className="flex h-7 items-center gap-1.5 overflow-hidden whitespace-nowrap px-3 text-xs text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => setEvalExpanded((v) => !v)}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm hover:bg-accent"
                    aria-label={row.evalOpen ? "Collapse evaluation" : "Expand evaluation"}
                  >
                    <ChevronRight
                      className={cn("h-3.5 w-3.5 transition-transform", row.evalOpen && "rotate-90")}
                    />
                  </button>
                  <Scale className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="shrink-0 font-medium text-foreground">Evaluation</span>
                  <span className="shrink-0 text-success">{row.evalPassed} pass</span>
                  <span className={cn("shrink-0", row.evalFailed > 0 ? "text-destructive" : "text-muted-foreground")}>
                    {row.evalFailed} fail
                  </span>
                </div>
              </div>
            );
          }
          if (
            node.call &&
            evaluation !== null &&
            isEvaluationRoot(node.call.step_name ?? "") &&
            evaluation.memberIds.has(node.call.id) &&
            judgeRoots.some((j) => j.id === node.call!.id)
          ) {
            const pass = judgeVerdicts[node.call.id];
            return (
              <div
                key={node.id}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                style={{ position: "absolute", top: virtualRow.start, left: 0, width: "100%" }}
              >
                <button
                  type="button"
                  onClick={() => selectCall(node.id)}
                  className="flex h-7 w-full items-center gap-1.5 overflow-hidden whitespace-nowrap px-3 pl-7 text-left text-xs hover:bg-accent/50"
                >
                  <span className={cn(
                    "shrink-0 rounded-sm px-1 py-0.5 text-[10px] font-semibold uppercase",
                    pass === true && "bg-success/15 text-success",
                    pass === false && "bg-destructive/15 text-destructive",
                    pass === undefined && "bg-muted text-muted-foreground",
                  )}>
                    {pass === true ? "pass" : pass === false ? "fail" : "—"}
                  </span>
                  <span className={cn("truncate", pass === false ? "text-destructive" : "text-foreground")}>
                    {node.call.step_name}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                    {formatDuration(node.call.latency_ms ?? undefined)}
                  </span>
                </button>
              </div>
            );
          }
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
                onToggle={toggleNode}
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
