"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TraceObservation } from "./contexts";
import type { CumulativeMetrics } from "@/lib/cumulative-metrics";
import { useSelection } from "./contexts/SelectionContext";
import { useTraceData } from "./contexts/TraceDataContext";
import { useViewPreferences } from "./contexts/ViewPreferencesContext";
import { getSemanticType } from "./trace-utils";
import {
  TYPE_COLORS,
  getDisplayName,
  getInlineMetricsStructured,
  computeTimingBounds,
} from "./trace-gantt-utils";
import { getHeatmapColor } from "./trace-heatmap";

interface TraceGanttChartProps {
  calls: TraceObservation[];
  searchQuery?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const SCALE_WIDTH = 900;
const STEP_SIZE = 100;
const ROW_HEIGHT = 42;
const TREE_INDENTATION = 12;
const PREDEFINED_STEP_SIZES = [
  0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25,
  35, 40, 45, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500,
];

// ─── Timeline calculations ──────────────────────────────────────────────────

function calculateStepSize(traceDurationSec: number): number {
  const calculated = traceDurationSec / (SCALE_WIDTH / STEP_SIZE);
  return (
    PREDEFINED_STEP_SIZES.find((s) => s >= calculated) ??
    PREDEFINED_STEP_SIZES[PREDEFINED_STEP_SIZES.length - 1]!
  );
}

// ─── Tree flattening with timeline metrics ──────────────────────────────────

interface FlatTimelineNode {
  id: string;
  call: TraceObservation | null;
  depth: number;
  treeLines: boolean[];
  isLastSibling: boolean;
  hasChildren: boolean;
  startOffset: number;
  itemWidth: number;
  firstTokenOffset: number | null;
}

function flattenWithTimeline(
  calls: TraceObservation[],
  expanded: Set<string>,
  bounds: { minTs: number; spanMs: number },
  searchQuery: string,
): FlatTimelineNode[] {
  const result: FlatTimelineNode[] = [];
  const byId = new Map(calls.map((c) => [c.id, c]));
  const q = searchQuery.trim().toLowerCase();

  const matchesCall = (call: TraceObservation) =>
    !q ||
    [call.step_name, call.call_type, call.model, call.tool_name].some(
      (v) => typeof v === "string" && v.toLowerCase().includes(q),
    );

  const matchingIds = (() => {
    if (!q) return null;
    const included = new Set<string>();
    for (const call of calls) {
      if (!matchesCall(call)) continue;
      let cur: TraceObservation | undefined = call;
      while (cur) {
        included.add(cur.id);
        cur = cur.parent_call_id ? byId.get(cur.parent_call_id) : undefined;
      }
    }
    return included;
  })();

  const getChildren = (callId: string | null): TraceObservation[] =>
    calls
      .filter(
        (c) =>
          (callId === null ? !c.parent_call_id : c.parent_call_id === callId) &&
          (!matchingIds || matchingIds.has(c.id)),
      )
      .sort((a, b) => {
        // Fall back to created_at when step_index is absent (agent-task spans),
        // so siblings render in true chronological order, not array order.
        const ai = a.step_index;
        const bi = b.step_index;
        if (ai != null && bi != null) return ai - bi;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });

  const computeMetrics = (call: TraceObservation) => {
    const start = new Date(call.created_at).getTime();
    const latency = call.latency_ms ?? 0;
    const startOffset =
      ((start - bounds.minTs) / bounds.spanMs) * SCALE_WIDTH;
    const itemWidth = Math.max(
      (latency / bounds.spanMs) * SCALE_WIDTH,
      call.latency_ms == null ? 10 : 2,
    );
    const firstTokenOffset =
      call.time_to_first_token_ms != null && latency > 0
        ? startOffset +
          (call.time_to_first_token_ms / bounds.spanMs) * SCALE_WIDTH
        : null;
    return { startOffset, itemWidth, firstTokenOffset };
  };

  // Virtual root node
  const rootChildren = getChildren(null);
  result.push({
    id: "root-run",
    call: null,
    depth: 0,
    treeLines: [],
    isLastSibling: true,
    hasChildren: rootChildren.length > 0,
    startOffset: 0,
    itemWidth: SCALE_WIDTH,
    firstTokenOffset: null,
  });

  if (!(expanded.has("root-run") || q) || rootChildren.length === 0) return result;

  const stack: Array<{
    call: TraceObservation;
    depth: number;
    treeLines: boolean[];
    isLastSibling: boolean;
  }> = [];

  const sortedRoots = [...rootChildren];
  for (let i = sortedRoots.length - 1; i >= 0; i--) {
    stack.push({
      call: sortedRoots[i]!,
      depth: 1,
      treeLines: [],
      isLastSibling: i === sortedRoots.length - 1,
    });
  }

  while (stack.length > 0) {
    const current = stack.pop()!;
    const call = current.call;
    const id = call.id;
    const children = getChildren(id);
    const metrics = computeMetrics(call);

    result.push({
      id,
      call,
      depth: current.depth,
      treeLines: current.treeLines,
      isLastSibling: current.isLastSibling,
      hasChildren: children.length > 0,
      ...metrics,
    });

    if ((expanded.has(id) || q) && children.length > 0) {
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i]!;
        stack.push({
          call: child,
          depth: current.depth + 1,
          treeLines: [...current.treeLines, i !== children.length - 1],
          isLastSibling: i === children.length - 1,
        });
      }
    }
  }

  return result;
}

// ─── Time scale header ──────────────────────────────────────────────────────

function formatTimeLabel(seconds: number): string {
  if (seconds < 0.1) return `${(seconds * 1000).toFixed(0)}ms`;
  if (seconds < 1) return `${seconds.toFixed(2)}s`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function TimelineScale({
  traceDurationSec,
  stepSize,
}: {
  traceDurationSec: number;
  stepSize: number;
}) {
  const numMarkers = Math.ceil(SCALE_WIDTH / STEP_SIZE) + 1;

  return (
    <div>
      <div className="relative h-7" style={{ width: `${SCALE_WIDTH}px` }}>
        {Array.from({ length: numMarkers }).map((_, i) => {
          const timeValue = stepSize * i;
          if (timeValue > traceDurationSec) return null;
          return (
            <div
              key={i}
              className="absolute h-full border-l border-border"
              style={{ left: `${i * STEP_SIZE}px` }}
            >
              <span className="text-muted-foreground absolute left-1 top-0 text-[10px] font-mono leading-7">
                {formatTimeLabel(timeValue)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Timeline bar ───────────────────────────────────────────────────────────

function TimelineBar({
  node,
  cumulative,
  isSelected,
  onSelect,
  showDuration,
  showCostTokens,
  colorCodeMetrics,
  maxDuration,
  totalCost,
}: {
  node: FlatTimelineNode;
  cumulative?: CumulativeMetrics;
  isSelected: boolean;
  onSelect: () => void;
  showDuration: boolean;
  showCostTokens: boolean;
  colorCodeMetrics: boolean;
  maxDuration: number;
  totalCost: number;
}) {
  const { call } = node;
  const isRun = call === null;
  const semType = isRun ? "TRACE" : getSemanticType(call!);
  const colors = TYPE_COLORS[semType] ?? TYPE_COLORS.SPAN;
  const name = isRun ? "Trace" : getDisplayName(call!);
  const metrics = isRun
    ? []
    : getInlineMetricsStructured(call!, cumulative, {
        showDuration,
        showCostTokens,
      });
  const hasChildren = node.hasChildren;
  const hasTTFT = node.firstTokenOffset !== null && !isRun;
  const ttftWidth = hasTTFT
    ? Math.max(node.firstTokenOffset! - node.startOffset, 0)
    : 0;
  const completionWidth = hasTTFT
    ? Math.max(node.itemWidth - ttftWidth, 0)
    : node.itemWidth;

  const barWidth = `${node.itemWidth || 10}px`;
  const barML = `${node.startOffset}px`;
  const isZeroDuration = !isRun && (call!.latency_ms == null || call!.latency_ms === 0);

  return (
    <div
      className="group flex cursor-pointer flex-row items-center"
      role="button"
      tabIndex={0}
      aria-label="Select trace node"
      style={{ marginLeft: barML }}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
    >
      {isRun ? (
        <div
          className={cn(
            "flex h-8 items-center rounded-sm border",
            colors.bar,
            isSelected && "ring-2 ring-primary ring-offset-1",
          )}
          style={{ width: barWidth }}
        >
          <span className={cn("ml-2 text-xs font-medium", colors.text)}>
            {colors.label}
          </span>
          <span className="ml-2 text-sm font-medium text-foreground whitespace-nowrap">
            {name}
          </span>
        </div>
      ) : hasTTFT ? (
        <div
          className={cn(
            "flex rounded-sm border border-border",
            isSelected
              ? "ring-2 ring-primary"
              : "group-hover:ring-2 group-hover:ring-muted-foreground/30",
          )}
        >
          {/* First token waiting bar */}
          <div
            className={cn(
              "flex h-8 items-center rounded-l-sm border-r border-border opacity-50",
              colors.bar,
              isZeroDuration && "border-dashed",
            )}
            style={{ width: `${ttftWidth}px` }}
          />
          {/* Completion bar */}
          <div
            className={cn(
              "flex h-8 items-center rounded-r-sm",
              colors.bar,
              isZeroDuration && "border border-dashed",
            )}
            style={{ width: `${completionWidth}px` }}
          >
            <BarContents
              colors={colors}
              name={name}
              metrics={metrics}
              hasChildren={hasChildren}
              colorCodeMetrics={colorCodeMetrics}
              call={call!}
              maxDuration={maxDuration}
              totalCost={totalCost}
              cumulative={cumulative}
            />
          </div>
        </div>
      ) : (
        <div
          className={cn(
            "flex h-8 items-center rounded-sm border border-border",
            colors.bar,
            isZeroDuration && "border-dashed",
            isSelected
              ? "ring-2 ring-primary"
              : "group-hover:ring-2 group-hover:ring-muted-foreground/30",
          )}
          style={{ width: barWidth }}
        >
          <BarContents
            colors={colors}
            name={name}
            metrics={metrics}
            hasChildren={hasChildren}
            colorCodeMetrics={colorCodeMetrics}
            call={call!}
            maxDuration={maxDuration}
            totalCost={totalCost}
            cumulative={cumulative}
          />
        </div>
      )}
    </div>
  );
}

function BarContents({
  colors,
  name,
  metrics,
  hasChildren,
  colorCodeMetrics,
  call,
  maxDuration,
  totalCost,
  cumulative,
}: {
  colors: (typeof TYPE_COLORS)[string];
  name: string;
  metrics: { text: string; kind: string }[];
  hasChildren: boolean;
  colorCodeMetrics: boolean;
  call: TraceObservation;
  maxDuration: number;
  totalCost: number;
  cumulative?: CumulativeMetrics;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground",
        hasChildren ? "ml-6" : "ml-1",
      )}
    >
      <span
        className={cn(
          "shrink-0 rounded-sm bg-background/80 px-1 py-px text-[8px] font-bold",
          colors.text,
        )}
      >
        {colors.label}
      </span>
      <span className="text-sm font-medium whitespace-nowrap text-foreground">
        {name}
      </span>
      {metrics.length > 0 && (
        <span className="flex shrink-0 items-center gap-1">
          {metrics.map((m, i) => {
            const heatClass =
              colorCodeMetrics && m.kind === "duration"
                ? getHeatmapColor(call.latency_ms ?? 0, maxDuration)
                : colorCodeMetrics && m.kind === "cost"
                  ? getHeatmapColor(
                      cumulative && cumulative.descendant_count > 0
                        ? cumulative.cost
                        : (call.cost ?? 0),
                      totalCost,
                    )
                  : undefined;
            return (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-muted-foreground/40">·</span>}
                <span className={cn("font-mono", heatClass)}>{m.text}</span>
              </span>
            );
          })}
        </span>
      )}
    </div>
  );
}

// ─── Timeline row (tree lines + bar) ────────────────────────────────────────

function TimelineRow({
  node,
  expanded,
  onToggle,
  isSelected,
  onSelect,
  cumulative,
  showDuration,
  showCostTokens,
  colorCodeMetrics,
  maxDuration,
  totalCost,
}: {
  node: FlatTimelineNode;
  expanded: boolean;
  onToggle: () => void;
  isSelected: boolean;
  onSelect: () => void;
  cumulative?: CumulativeMetrics;
  showDuration: boolean;
  showCostTokens: boolean;
  colorCodeMetrics: boolean;
  maxDuration: number;
  totalCost: number;
}) {
  const { depth, treeLines, isLastSibling } = node;

  return (
    <div className="group my-0.5 flex min-w-fit cursor-pointer flex-row items-center">
      {/* Ancestor tree lines */}
      {depth > 0 &&
        Array.from({ length: depth - 1 }, (_, i) => (
          <div
            key={i}
            className="relative shrink-0"
            style={{ width: `${TREE_INDENTATION}px` }}
          >
            {treeLines[i] && (
              <div className="absolute bottom-0 left-1.5 top-0 w-px bg-border" />
            )}
          </div>
        ))}

      {/* Current-level connector */}
      {depth > 0 && (
        <div
          className="relative shrink-0"
          style={{ width: `${TREE_INDENTATION}px` }}
        >
          <div
            className={cn(
              "absolute left-1.5 top-0 w-px bg-border",
              isLastSibling ? "h-3" : "bottom-0",
            )}
          />
          <div className="absolute left-1.5 top-3 h-px w-2 bg-border" />
        </div>
      )}

      {/* Expand/collapse chevron */}
      {node.hasChildren && (
        <button
          type="button"
          aria-label={expanded ? "Collapse node" : "Expand node"}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="hover:bg-muted/50 absolute z-10 rounded"
          style={{
            left: `${depth * TREE_INDENTATION + (node.startOffset > 0 ? node.startOffset + 4 : 4)}px`,
            top: "50%",
            transform: "translateY(-50%)",
          }}
        >
          <ChevronRight
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform duration-200",
              !expanded && "rotate-0",
              expanded && "rotate-90",
            )}
          />
        </button>
      )}

      {/* The bar */}
      <TimelineBar
        node={node}
        cumulative={cumulative}
        isSelected={isSelected}
        onSelect={onSelect}
        showDuration={showDuration}
        showCostTokens={showCostTokens}
        colorCodeMetrics={colorCodeMetrics}
        maxDuration={maxDuration}
        totalCost={totalCost}
      />
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export function TraceGanttChart({
  calls,
  searchQuery = "",
}: TraceGanttChartProps) {
  const timeIndexRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const { selectCall, selectedCallId } = useSelection();
  const { cumulativeMetrics } = useTraceData();
  const { preferences } = useViewPreferences();

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>(["root-run"]);
    calls.forEach((c) => s.add(c.id));
    return s;
  });

  const bounds = useMemo(() => computeTimingBounds(calls), [calls]);
  const totalCost = useMemo(
    () => calls.reduce((sum, c) => sum + (c.cost ?? 0), 0),
    [calls],
  );
  const traceDurationSec = bounds.spanMs / 1000;
  const stepSize = useMemo(
    () => calculateStepSize(traceDurationSec),
    [traceDurationSec],
  );

  const flatNodes = useMemo(
    () =>
      flattenWithTimeline(
        calls,
        expanded,
        { minTs: bounds.minTs, spanMs: bounds.spanMs },
        searchQuery,
      ),
    [calls, expanded, bounds, searchQuery],
  );

  const contentWidth = useMemo(() => {
    if (flatNodes.length === 0) return SCALE_WIDTH;
    const maxEnd = Math.max(
      ...flatNodes.map((n) => n.startOffset + n.itemWidth),
    );
    // Reserve trailing room so labels that overflow short bars stay reachable
    // by horizontal scroll (e.g. 0ms spans whose name extends past the bar).
    const maxLabelChars = Math.max(
      ...flatNodes.map((n) =>
        n.call ? getDisplayName(n.call).length : "Trace".length,
      ),
      0,
    );
    const trailingRoom = Math.max(maxLabelChars * 7 + 180, 240);
    return Math.max(SCALE_WIDTH, maxEnd + trailingRoom);
  }, [flatNodes]);

  const toggleNode = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleTimeIndexScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (contentRef.current) {
        contentRef.current.scrollLeft = e.currentTarget.scrollLeft;
      }
    },
    [],
  );

  const handleContentScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (timeIndexRef.current) {
        timeIndexRef.current.scrollLeft = e.currentTarget.scrollLeft;
      }
    },
    [],
  );

  const virtualizer = useVirtualizer({
    count: flatNodes.length,
    getScrollElement: () => contentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  if (calls.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">No calls in this trace.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Sticky time scale header */}
      <div
        ref={timeIndexRef}
        className="overflow-x-auto overflow-y-hidden border-b border-border/50"
        onScroll={handleTimeIndexScroll}
      >
        <div style={{ width: `${contentWidth}px` }}>
          <TimelineScale
            traceDurationSec={traceDurationSec}
            stepSize={stepSize}
          />
        </div>
      </div>

      {/* Main scrollable content with virtualized rows */}
      <div
        ref={contentRef}
        className="flex-1 overflow-auto"
        onScroll={handleContentScroll}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: `${contentWidth}px`,
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((vr) => {
            const node = flatNodes[vr.index];
            if (!node) return null;
            const isSelected =
              node.call === null
                ? !selectedCallId
                : selectedCallId === node.call.id;
            const cumulative = node.call
              ? cumulativeMetrics.get(node.call.id)
              : undefined;

            return (
              <div
                key={node.id}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${vr.size}px`,
                  transform: `translateY(${vr.start}px)`,
                }}
              >
                <TimelineRow
                  node={node}
                  expanded={expanded.has(node.id)}
                  onToggle={() => toggleNode(node.id)}
                  isSelected={isSelected}
                  onSelect={() => selectCall(node.call?.id ?? null)}
                  cumulative={cumulative}
                  showDuration={preferences.showDuration}
                  showCostTokens={preferences.showCostTokens}
                  colorCodeMetrics={preferences.colorCodeMetrics}
                  maxDuration={bounds.spanMs}
                  totalCost={totalCost}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
