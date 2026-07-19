"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
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
  fillHeight?: boolean;
  className?: string;
}

export function ExpandableJson({
  data,
  label,
  fillHeight = false,
  className,
}: ExpandableJsonProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    if (data === null || data === undefined) return new Set();
    const s = new Set<string>();
    const root = buildTree(data, null, "root", 0);
    function autoCollapse(node: JsonNode, depth: number) {
      if (
        (node.type === "object" || node.type === "array") &&
        node.childCount > 0
      ) {
        if (depth >= 2 || node.childCount > 8) s.add(node.id);
        node.children.forEach((c) => autoCollapse(c, depth + 1));
      }
    }
    autoCollapse(root, 0);
    return s;
  });

  const [searchInput, setSearchInput] = useState("");
  const [stringMode, setStringMode] = useState<StringMode>("truncate");
  const [showLineNumbers, setShowLineNumbers] = useState(false);
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  const root = useMemo(() => {
    if (data === null || data === undefined) return null;
    try {
      const parsed = typeof data === "string" ? JSON.parse(data) : data;
      return buildTree(parsed, null, "root", 0);
    } catch {
      return buildTree(data, null, "root", 0);
    }
  }, [data]);

  const searchQuery = searchInput.trim();
  const matches = useMemo(
    () => (root ? collectMatches(root, searchQuery) : null),
    [root, searchQuery],
  );

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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

  // Reset the active match when the search box changes — derived during render
  // instead of an effect to avoid a stale-state flash.
  const [prevSearchQuery, setPrevSearchQuery] = useState(searchQuery);
  if (searchQuery !== prevSearchQuery) {
    setPrevSearchQuery(searchQuery);
    setCurrentMatchIdx(0);
  }

  const safeMatchIdx =
    matchCount > 0 ? Math.min(currentMatchIdx, matchCount - 1) : -1;
  const currentMatchRowIdx =
    safeMatchIdx >= 0 ? matchRowIndices[safeMatchIdx] : -1;

  const navigateMatch = useCallback(
    (direction: "prev" | "next") => {
      if (matchCount === 0) return;
      setCurrentMatchIdx((prev) => {
        if (direction === "next") return (prev + 1) % matchCount;
        return (prev - 1 + matchCount) % matchCount;
      });
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
    if (!scrollRef.current) return;
    setScrollTop(scrollRef.current.scrollTop);
    if (shouldVirtualize) {
      setContainerHeight(scrollRef.current.clientHeight);
    }
  }, [shouldVirtualize]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setContainerHeight(el.clientHeight);
  }, []);

  const virtualRange = useMemo(() => {
    if (!shouldVirtualize) return { start: 0, end: rows.length };
    const start = Math.max(
      0,
      Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN,
    );
    const end = Math.min(
      rows.length,
      Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN,
    );
    return { start, end };
  }, [shouldVirtualize, scrollTop, containerHeight, rows.length]);

  const visibleRows = shouldVirtualize
    ? rows.slice(virtualRange.start, virtualRange.end)
    : rows;

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        navigateMatch(e.shiftKey ? "prev" : "next");
      }
    },
    [navigateMatch],
  );

  const cycleStringMode = useCallback(() => {
    setStringMode((m) => {
      if (m === "truncate") return "wrap";
      if (m === "wrap") return "nowrap";
      return "truncate";
    });
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
        searchInput={searchInput}
        searchQuery={searchQuery}
        onSearchChange={setSearchInput}
        onSearchKeyDown={handleSearchKeyDown}
        matchCount={matchCount}
        safeMatchIdx={safeMatchIdx}
        onNavigate={navigateMatch}
        stringMode={stringMode}
        onCycleStringMode={cycleStringMode}
        showLineNumbers={showLineNumbers}
        onToggleLineNumbers={() => setShowLineNumbers((v) => !v)}
        data={data}
      />

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={cn(
          "overflow-auto bg-gradient-to-b from-background/60 via-background to-muted/20",
          fillHeight ? "min-h-[320px] max-h-[70vh]" : "max-h-[520px]",
        )}
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
