"use client";

import { useMemo, useState, useCallback, useReducer, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import {
  type StringMode,
  type JsonNode,
  ROW_HEIGHT,
  VIRTUALIZE_THRESHOLD,
  OVERSCAN,
  buildTree,
  flattenVisible,
  collectMatches,
} from "./expandable-json/utils";
import { JsonRow } from "./expandable-json/rows";
import { Toolbar } from "./expandable-json/toolbar";

interface ExpandableJsonProps {
  data: unknown;
  label?: string;
  className?: string;
}

// Search box + active match index: typing a new query resets the active
// match, so the pair transitions together in one reducer.
type SearchState = { input: string; matchIdx: number };
type SearchAction =
  | { type: "SET_INPUT"; value: string }
  | { type: "NAVIGATE"; direction: "prev" | "next"; count: number };

function searchReducer(state: SearchState, action: SearchAction): SearchState {
  switch (action.type) {
    case "SET_INPUT":
      return { input: action.value, matchIdx: 0 };
    case "NAVIGATE": {
      if (action.count === 0) return state;
      const idx =
        action.direction === "next"
          ? (state.matchIdx + 1) % action.count
          : (state.matchIdx - 1 + action.count) % action.count;
      return { ...state, matchIdx: idx };
    }
  }
}

// Virtualization viewport: scroll offset plus the measured container height.
type ViewportState = { scrollTop: number; containerHeight: number };
type ViewportAction =
  | { type: "SCROLL"; top: number; height?: number }
  | { type: "MEASURE"; height: number };

function viewportReducer(state: ViewportState, action: ViewportAction): ViewportState {
  switch (action.type) {
    case "SCROLL":
      return {
        scrollTop: action.top,
        containerHeight: action.height ?? state.containerHeight,
      };
    case "MEASURE":
      return { ...state, containerHeight: action.height };
  }
}

export function ExpandableJson({
  data,
  label,
  className,
}: ExpandableJsonProps) {
  const root = useMemo(() => {
    if (data === null || data === undefined) return null;
    try {
      const parsed = typeof data === "string" ? JSON.parse(data) : data;
      return buildTree(parsed, null, "root", 0);
    } catch {
      return buildTree(data, null, "root", 0);
    }
  }, [data]);

  // Auto-collapse is derived from the displayed tree instead of copied into
  // state at mount; user toggles layer on top of it as per-node overrides.
  const autoCollapsed = useMemo(() => collectAutoCollapsed(root), [root]);
  const [collapseOverrides, setCollapseOverrides] = useState<Record<string, boolean>>({});
  const collapsed = useMemo(
    () => applyCollapseOverrides(autoCollapsed, collapseOverrides),
    [autoCollapsed, collapseOverrides],
  );

  const [search, dispatchSearch] = useReducer(searchReducer, { input: "", matchIdx: 0 });
  const [stringMode, setStringMode] = useState<StringMode>("truncate");
  const [showLineNumbers, setShowLineNumbers] = useState(false);
  const [viewport, dispatchViewport] = useReducer(viewportReducer, {
    scrollTop: 0,
    containerHeight: 0,
  });

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Ref callback (rather than a mount effect) so the container is measured
  // exactly when it attaches, initializing the virtualization viewport.
  const measureRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    if (el) dispatchViewport({ type: "MEASURE", height: el.clientHeight });
  }, []);

  const searchQuery = search.input.trim();
  const matches = useMemo(
    () => (root ? collectMatches(root, searchQuery) : null),
    [root, searchQuery],
  );

  const toggle = useCallback((id: string) => {
    setCollapseOverrides((prev) => {
      const base = prev[id] !== undefined ? prev[id] : autoCollapsed.has(id);
      return { ...prev, [id]: !base };
    });
  }, [autoCollapsed]);

  const rows = useMemo(() => {
    if (!root) return [];
    return flattenVisible([root], collapsed, matches);
  }, [root, collapsed, matches]);

  const matchRowIndices = useMemo(() => {
    if (!matches) return [];
    return rows.flatMap((r, i) =>
      matches.direct.has(r.node.id) ? [i] : [],
    );
  }, [rows, matches]);

  const matchCount = matchRowIndices.length;

  // The active match index lives in the search reducer, so it resets with the
  // query in a single transition — no render-phase state adjustment needed.
  const safeMatchIdx =
    matchCount > 0 ? Math.min(search.matchIdx, matchCount - 1) : -1;
  const currentMatchRowIdx =
    safeMatchIdx >= 0 ? matchRowIndices[safeMatchIdx] : -1;

  const navigateMatch = useCallback(
    (direction: "prev" | "next") => {
      dispatchSearch({ type: "NAVIGATE", direction, count: matchCount });
    },
    [matchCount],
  );

  useEffect(() => {
    if (currentMatchRowIdx < 0 || !scrollRef.current) return;
    const top = currentMatchRowIdx * ROW_HEIGHT;
    const el = scrollRef.current;
    if (
      top < el.scrollTop ||
      top > el.scrollTop + el.clientHeight - ROW_HEIGHT
    ) {
      el.scrollTop = top - el.clientHeight / 3;
    }
  }, [currentMatchRowIdx]);

  const shouldVirtualize = rows.length > VIRTUALIZE_THRESHOLD;

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    dispatchViewport({
      type: "SCROLL",
      top: el.scrollTop,
      height: shouldVirtualize ? el.clientHeight : undefined,
    });
  }, [shouldVirtualize]);

  const virtualRange = useMemo(() => {
    if (!shouldVirtualize) return { start: 0, end: rows.length };
    const start = Math.max(
      0,
      Math.floor(viewport.scrollTop / ROW_HEIGHT) - OVERSCAN,
    );
    const end = Math.min(
      rows.length,
      Math.ceil((viewport.scrollTop + viewport.containerHeight) / ROW_HEIGHT) + OVERSCAN,
    );
    return { start, end };
  }, [shouldVirtualize, viewport, rows.length]);

  const visibleRows = shouldVirtualize
    ? rows.slice(virtualRange.start, virtualRange.end)
    : rows;

  const handleSearchChange = useCallback(
    (value: string) => dispatchSearch({ type: "SET_INPUT", value }),
    [],
  );

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        dispatchSearch({ type: "NAVIGATE", direction: e.shiftKey ? "prev" : "next", count: matchRowIndices.length });
      }
    },
    [matchRowIndices.length],
  );

  const cycleStringMode = useCallback(() => {
    setStringMode((m) => {
      if (m === "truncate") return "wrap";
      if (m === "wrap") return "nowrap";
      return "truncate";
    });
  }, []);

  const handleToggleLineNumbers = useCallback(() => {
    setShowLineNumbers((v) => !v);
  }, []);

  if (data === undefined || data === null) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  return (
    <div
      className={cn(
        "w-full rounded-md border border-border bg-card/80 shadow-sm overflow-hidden",
        className,
      )}
    >
      <Toolbar
        label={label}
        searchInput={search.input}
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        onSearchKeyDown={handleSearchKeyDown}
        matchCount={matchCount}
        safeMatchIdx={safeMatchIdx}
        onNavigate={navigateMatch}
        stringMode={stringMode}
        onCycleStringMode={cycleStringMode}
        showLineNumbers={showLineNumbers}
        onToggleLineNumbers={handleToggleLineNumbers}
        data={data}
      />

      <div
        ref={measureRef}
        onScroll={handleScroll}
        className="max-h-[520px] overflow-auto bg-gradient-to-b from-background/60 via-background to-muted/20"
      >
        {rows.length === 0 && searchQuery ? (
          <EmptySearchResult query={searchQuery} />
        ) : shouldVirtualize ? (
          <VirtualizedList
            rows={visibleRows}
            virtualRange={virtualRange}
            collapsed={collapsed}
            searchQuery={searchQuery}
            stringMode={stringMode}
            showLineNumbers={showLineNumbers}
            currentMatchRowIdx={currentMatchRowIdx}
            totalRows={rows.length}
            onToggle={toggle}
          />
        ) : (
          rows.map(({ node, isLast }, i) => (
            <JsonRow
              key={node.id}
              node={node}
              isLast={isLast}
              isCollapsed={collapsed.has(node.id)}
              searchQuery={searchQuery}
              lineNumber={i + 1}
              display={{
                isCurrentMatch: i === currentMatchRowIdx,
                showLineNumbers,
                stringMode,
              }}
              onToggle={() => toggle(node.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function collectAutoCollapsed(root: JsonNode | null): Set<string> {
  const collapsed = new Set<string>();
  if (!root) return collapsed;
  function autoCollapse(node: JsonNode, depth: number) {
    if (
      (node.type === "object" || node.type === "array") &&
      node.childCount > 0
    ) {
      if (depth >= 2 || node.childCount > 8) collapsed.add(node.id);
      node.children.forEach((c) => autoCollapse(c, depth + 1));
    }
  }
  autoCollapse(root, 0);
  return collapsed;
}

function applyCollapseOverrides(
  autoCollapsed: Set<string>,
  overrides: Record<string, boolean>,
): Set<string> {
  if (Object.keys(overrides).length === 0) return autoCollapsed;
  const collapsed = new Set(autoCollapsed);
  for (const [id, isCollapsed] of Object.entries(overrides)) {
    if (isCollapsed) collapsed.add(id);
    else collapsed.delete(id);
  }
  return collapsed;
}

function VirtualizedList({
  rows,
  virtualRange,
  collapsed,
  searchQuery,
  stringMode,
  showLineNumbers,
  currentMatchRowIdx,
  totalRows,
  onToggle,
}: {
  rows: Array<{ node: JsonNode; isLast: boolean }>;
  virtualRange: { start: number; end: number };
  collapsed: Set<string>;
  searchQuery: string;
  stringMode: StringMode;
  showLineNumbers: boolean;
  currentMatchRowIdx: number;
  totalRows: number;
  onToggle: (id: string) => void;
}) {
  return (
    <div style={{ height: totalRows * ROW_HEIGHT, position: "relative" }}>
      <div
        style={{
          position: "absolute",
          top: virtualRange.start * ROW_HEIGHT,
          left: 0,
          right: 0,
        }}
      >
        {rows.map(({ node, isLast }, i) => {
          const rowIdx = virtualRange.start + i;
          return (
            <JsonRow
              key={node.id}
              node={node}
              isLast={isLast}
              isCollapsed={collapsed.has(node.id)}
              searchQuery={searchQuery}
              lineNumber={rowIdx + 1}
              display={{
                isCurrentMatch: rowIdx === currentMatchRowIdx,
                showLineNumbers,
                stringMode,
              }}
              onToggle={() => onToggle(node.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function EmptySearchResult({ query }: { query: string }) {
  return (
    <div className="px-3 py-6 text-center text-xs text-muted-foreground">
      No matches for &quot;{query}&quot;
    </div>
  );
}
