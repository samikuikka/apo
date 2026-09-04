"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, ArrowLeft, Download, Settings2, ChevronLeft, ChevronRight, AlertTriangle, PanelLeft, Radio } from "lucide-react";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useProjectId } from "@/lib/project-router";
import { usePanelRef, type PanelSize } from "react-resizable-panels";
import { toast } from "sonner";
import { getCommentCounts } from "@/lib/comments-api";
import { getTraceDetail } from "@/lib/traces-api";
import { setSearchParamShallow } from "@/lib/shallow-search-params";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import dynamic from "next/dynamic";
const TraceGraph = dynamic(() => import("./TraceGraph").then(m => ({ default: m.TraceGraph })), { ssr: false });
import { TraceDetailView } from "./TraceDetailView";
import { TraceTree } from "./TraceTree";
import { TraceGanttChart } from "./TraceGanttChart";
import { TraceLayoutMobile } from "./TraceLayoutMobile";
import { mergeLiveCalls } from "./merge-live-calls";
import { useTraceStream } from "@/hooks/use-trace-stream";
import type { TraceDetail } from "./contexts";
import { TraceDataProvider, LARGE_TRACE_THRESHOLD, GRAPH_DISABLED_THRESHOLD } from "./contexts/TraceDataContext";
import { ViewPreferencesProvider, useViewPreferences, type ViewPreferences } from "./contexts/ViewPreferencesContext";
import { useSelection, type NavigationView } from "./contexts/SelectionContext";
import {
  DEFAULT_NAV_SIZE,
  COLLAPSED_SIZE,
  MIN_NAV_SIZE,
  MAX_NAV_SIZE,
} from "./trace-nav-storage";

interface TraceWorkspaceProps {
  run: TraceDetail;
  mode?: "page" | "panel";
  onClose?: () => void;
  backHref?: string;
  backLabel?: string;
  className?: string;
  refreshRun?: () => void;
  prevId?: string | null;
  nextId?: string | null;
}

async function downloadTrace(run: TraceDetail, projectId?: string) {
  if (run.calls.length > 50) {
    toast.info(`Downloading trace with ${run.calls.length} observations`);
  }
  // The workspace may hold a slim fetch (call metadata only) — an explicit
  // export must carry the full payloads, so re-fetch without slim.
  const data = run.slim_calls
    ? await getTraceDetail(run.run.id, projectId)
    : { run: run.run, calls: run.calls, metrics: run.metrics };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `trace-${run.run.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function useCommentCounts(run: TraceDetail) {
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const callIdKey = run.calls.map((c) => c.id).join(",");

  useEffect(() => {
    const runId = run.run.id;
    const callIds = callIdKey ? callIdKey.split(",") : [];
    const allIds = [runId, ...callIds];

    let cancelled = false;
    getCommentCounts(allIds, "trace").then((counts) => {
      if (!cancelled) setCommentCounts(counts);
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [run.run.id, callIdKey]);

  return commentCounts;
}

function ViewPreferencesDropdown() {
  const { preferences, updatePreference } = useViewPreferences();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="View preferences">
          <Settings2 className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuCheckboxItem
          checked={preferences.showDuration}
          onCheckedChange={(checked) => updatePreference("showDuration", checked === true)}
        >
          Duration
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={preferences.showCostTokens}
          onCheckedChange={(checked) => updatePreference("showCostTokens", checked === true)}
        >
          Cost & Tokens
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={preferences.showScores}
          onCheckedChange={(checked) => updatePreference("showScores", checked === true)}
        >
          Scores
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={preferences.showComments}
          onCheckedChange={(checked) => updatePreference("showComments", checked === true)}
        >
          Comments
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={preferences.colorCodeMetrics}
          onCheckedChange={(checked) => updatePreference("colorCodeMetrics", checked === true)}
        >
          Color-code metrics
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Min level</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={preferences.minObservationLevel}
              onValueChange={(value) => updatePreference("minObservationLevel", value as ViewPreferences["minObservationLevel"])}
            >
              <DropdownMenuRadioItem value="DEFAULT">All</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="DEBUG">Debug+</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="WARNING">Warning+</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="ERROR">Errors only</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TraceNavToolbar({
  run,
  isLive,
  backHref,
  backLabel,
  searchQuery,
  onSearchQueryChange,
  prevId,
  nextId,
}: {
  run: TraceDetail;
  isLive: boolean;
  backHref?: string;
  backLabel?: string;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  prevId: string | null;
  nextId: string | null;
}) {
  const router = useRouter();
  const projectId = useProjectId();

  const navigateTo = useCallback(
    (id: string) => {
      router.push(`/project/${projectId}/traces/${id}`);
    },
    [router, projectId],
  );

  // Hold the latest navigateTo in a ref so the keydown subscription stays
  // stable and doesn't tear down/re-subscribe whenever navigateTo changes
  // identity. (Replaces the experimental React useEffectEvent API, which is
  // not available in the stable React shipped with this Next.js version.)
  // Written via useEffect (not in the render body) so render stays pure.
  const navigateToRef = useRef(navigateTo);
  useEffect(() => {
    navigateToRef.current = navigateTo;
  });

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.altKey && e.key === "ArrowLeft" && prevId) {
        e.preventDefault();
        navigateToRef.current(prevId);
      }
      if (e.altKey && e.key === "ArrowRight" && nextId) {
        e.preventDefault();
        navigateToRef.current(nextId);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [prevId, nextId]);

  return (
    <div className="flex items-center gap-2 px-2.5 py-2">
      {backHref && backLabel ? (
        <Link
          href={backHref}
          className="inline-flex h-7 items-center gap-1 px-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>{backLabel}</span>
        </Link>
      ) : (
        <div className="w-1" />
      )}

      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          disabled={!prevId}
          onClick={() => prevId && navigateTo(prevId)}
          aria-label="Previous trace"
          type="button"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          disabled={!nextId}
          onClick={() => nextId && navigateTo(nextId)}
          aria-label="Next trace"
          type="button"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          aria-label="Search trace"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          placeholder="Search trace"
          className="h-8 w-full border border-border/70 bg-background pl-8 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-ring"
        />
      </div>

      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {run.calls.length}
      </span>

      {isLive && (
        <span
          className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-success"
          title="This trace is still running — spans stream in live"
        >
          <Radio className="h-3 w-3 animate-pulse" />
          LIVE
        </span>
      )}

      {run.calls.length > LARGE_TRACE_THRESHOLD && (
        <span className="inline-flex shrink-0 items-center gap-1 border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning" title={`Large trace with ${run.calls.length} observations. Some features may be optimized for performance.`}>
          <AlertTriangle className="h-3 w-3" />
          {run.calls.length} obs
        </span>
      )}


      <ViewPreferencesDropdown />

      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        aria-label="Download trace as JSON"
        onClick={() => void downloadTrace(run, projectId)}
      >
        <Download className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function TraceNavTabs({
  run,
  activeView,
  onActiveViewChange,
}: {
  run: TraceDetail;
  activeView: NavigationView;
  onActiveViewChange: (value: NavigationView) => void;
}) {
  const isGraphDisabled = run.calls.length > GRAPH_DISABLED_THRESHOLD;

  return (
    <Tabs
      value={activeView === "graph" && isGraphDisabled ? "tree" : activeView}
      onValueChange={(v) => {
        if (v === "graph" && isGraphDisabled) {
          onActiveViewChange("tree");
          return;
        }
        onActiveViewChange(v as NavigationView);
      }}
    >
      <TabsList variant="line" className="gap-3">
        <TabsTrigger value="tree">Tree</TabsTrigger>
        <TabsTrigger value="timeline">Timeline</TabsTrigger>
        <TabsTrigger
          value="graph"
          disabled={isGraphDisabled}
          title={isGraphDisabled ? `Graph view disabled for traces with >${GRAPH_DISABLED_THRESHOLD} observations` : undefined}
        >
          Graph
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function TraceNavContent({
  run,
  activeView,
  searchQuery,
  commentCounts,
}: {
  run: TraceDetail;
  activeView: NavigationView;
  searchQuery: string;
  commentCounts: Record<string, number>;
}) {
  if (activeView === "tree") {
    return (
      <div className="h-full overflow-auto">
        <TraceTree
          calls={run.calls}
          searchQuery={searchQuery}
          runLabel={run.run.scopeKey || run.run.task_id || "Untitled trace"}
          commentCounts={commentCounts}
        />
      </div>
    );
  }

  if (activeView === "timeline") {
    return (
      <div className="h-full">
        <TraceGanttChart calls={run.calls} searchQuery={searchQuery} />
      </div>
    );
  }

  return (
    <div className="h-full overflow-hidden">
      <TraceGraph calls={run.calls} />
    </div>
  );
}

function TraceNavigation({
  run,
  isLive,
  backHref,
  backLabel,
  activeView,
  onActiveViewChange,
  searchQuery,
  onSearchQueryChange,
  commentCounts,
  prevId,
  nextId,
  onCollapse,
}: {
  run: TraceDetail;
  isLive: boolean;
  backHref?: string;
  backLabel?: string;
  activeView: NavigationView;
  onActiveViewChange: (value: NavigationView) => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  commentCounts: Record<string, number>;
  prevId: string | null;
  nextId: string | null;
  onCollapse?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="border-b border-border/70 bg-background">
        <TraceNavToolbar
          run={run}
          isLive={isLive}
          backHref={backHref}
          backLabel={backLabel}
          searchQuery={searchQuery}
          onSearchQueryChange={onSearchQueryChange}
          prevId={prevId}
          nextId={nextId}
        />
        <div className="flex items-center px-2.5 pb-2 pt-0.5">
          <TraceNavTabs run={run} activeView={activeView} onActiveViewChange={onActiveViewChange} />
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              aria-label="Collapse tree panel"
              title="Collapse tree panel"
              className="ml-auto flex items-center text-muted-foreground hover:text-foreground"
            >
              <PanelLeft className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <TraceNavContent
          run={run}
          activeView={activeView}
          searchQuery={searchQuery}
          commentCounts={commentCounts}
        />
      </div>
    </div>
  );
}

function TraceDetailPane({ mode, onClose }: { mode: "page" | "panel"; onClose?: () => void }) {
  return (
    <div className="h-full min-h-0 min-w-0 overflow-auto bg-background">
      <TraceDetailView mode={mode} onClose={onClose} />
    </div>
  );
}

function CollapsedNavRail({ onExpand }: { onExpand: () => void }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label="Expand navigation panel"
      title="Expand navigation panel"
      className="flex h-full w-full items-center justify-center border-r border-border bg-background transition-colors hover:bg-muted/40"
    >
      <PanelLeft className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

export function TraceWorkspace({
  run,
  mode = "page",
  onClose,
  backHref,
  backLabel,
  className,
  refreshRun,
  prevId = null,
  nextId = null,
}: TraceWorkspaceProps) {
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();
  const urlQuery = mode === "page" ? (searchParams.get("q") ?? "") : null;
  // Reading ?q during the first render would desync from the server-rendered
  // HTML (hydration mismatch); the state starts empty and follows the URL
  // via the prev-value comparison below.
  const [searchQuery, setSearchQuery] = useState("");
  const [lastUrlQuery, setLastUrlQuery] = useState<string | null>(null);

  // Follow ?q changes that did not come from our own typing (initial load,
  // back/forward) by adjusting during render with a prev-value comparison —
  // no effect-time syncing, so no frame ever shows a stale query.
  if (urlQuery !== null && urlQuery !== lastUrlQuery) {
    setLastUrlQuery(urlQuery);
    if (urlQuery !== searchQuery) setSearchQuery(urlQuery);
  }
  const { view, setView } = useSelection();

  // Live streaming: overlay SSE span events onto the server-fetched calls so
  // the tree/gantt fill in while the trace is still running. The stream only
  // carries a sparse subset (timing/model/type), so we field-merge to avoid
  // clobbering rich input/output from the initial snapshot. When the trace
  // completes we do one final `refreshRun` to pull authoritative final state.
  const traceCompleted = run.run.completed_at != null;
  const { calls: streamCalls, isLive } = useTraceStream(
    traceCompleted ? null : run.run.id,
  );
  const mergedCalls = useMemo(
    () => mergeLiveCalls(run.calls, streamCalls),
    [run.calls, streamCalls],
  );
  const liveRun: TraceDetail = useMemo(
    () =>
      streamCalls.length > 0
        ? { ...run, calls: mergedCalls }
        : run,
    [run, streamCalls.length, mergedCalls],
  );
  // Hold the latest refreshRun in a ref so the completion effect below doesn't
  // depend on the prop's identity — an inline `() => router.refresh()` from the
  // parent would otherwise re-arm the effect on every parent render. Latest-ref
  // pattern, same as navigateToRef in TraceNavToolbar.
  const refreshRunRef = useRef(refreshRun);
  useEffect(() => {
    refreshRunRef.current = refreshRun;
  });

  const prevIsLiveRef = useRef(isLive);
  useEffect(() => {
    // The trace just completed: pull final state once so the detail pane gets
    // authoritative input/output/cost for every span.
    if (prevIsLiveRef.current && !isLive) {
      refreshRunRef.current?.();
    }
    prevIsLiveRef.current = isLive;
  }, [isLive]);

  const commentCounts = useCommentCounts(liveRun);

  const navPanelRef = usePanelRef();
  const [isNavCollapsed, setIsNavCollapsed] = useState(false);

  const handleNavResize = useCallback((panelSize: PanelSize) => {
    setIsNavCollapsed(panelSize.inPixels <= COLLAPSED_SIZE);
  }, []);

  const toggleCollapse = useCallback(() => {
    const panel = navPanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, [navPanelRef]);

  useEffect(() => {
    if (mode !== "page") return;
    if (searchQuery === (searchParams.get("q") ?? "")) return;
    const timer = setTimeout(() => {
      // Shallow: keeps the URL shareable without re-running the server
      // component (which would re-fetch the whole trace) per keystroke.
      setSearchParamShallow("q", searchQuery || null);
    }, 300);
    return () => clearTimeout(timer);
  }, [mode, searchQuery, searchParams]);

  // Stable JSX props for the mobile layout: memoized elements keep their
  // identity across renders, so TraceLayoutMobile's own state changes
  // (accordion toggling) bail out of re-rendering these subtrees.
  const mobileTabs = useMemo(
    () => <TraceNavTabs run={liveRun} activeView={view} onActiveViewChange={setView} />,
    [liveRun, view, setView],
  );
  const mobileNavContent = useMemo(
    () => (
      <TraceNavContent
        run={liveRun}
        activeView={view}
        searchQuery={searchQuery}
        commentCounts={commentCounts}
      />
    ),
    [liveRun, view, searchQuery, commentCounts],
  );
  const mobileDetailContent = useMemo(
    () => <TraceDetailView mode={mode} onClose={onClose} />,
    [mode, onClose],
  );

  return (
    <TraceDataProvider run={liveRun} isLoading={false} error={null} refreshRun={refreshRun}>
      <ViewPreferencesProvider>
      <div
        className={cn(
          "flex h-full min-h-0 flex-col overflow-hidden bg-background",
          mode === "panel" ? "border-l border-border" : "",
          className,
        )}
      >
        {isMobile ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 border-b border-border/70 bg-background">
              <TraceNavToolbar
                run={liveRun}
                isLive={isLive}
                backHref={backHref}
                backLabel={backLabel}
                searchQuery={searchQuery}
                onSearchQueryChange={setSearchQuery}
                prevId={prevId}
                nextId={nextId}
              />
            </div>
            <div className="min-h-0 flex-1">
              <TraceLayoutMobile
                tabs={mobileTabs}
                navContent={mobileNavContent}
                detailContent={mobileDetailContent}
              />
            </div>
          </div>
        ) : (
        <ResizablePanelGroup direction="horizontal" className="min-h-0 min-w-0 flex-1">
          <ResizablePanel
            defaultSize={DEFAULT_NAV_SIZE}
            collapsible
            collapsedSize={COLLAPSED_SIZE}
            minSize={MIN_NAV_SIZE}
            maxSize={MAX_NAV_SIZE}
            panelRef={navPanelRef}
            onResize={handleNavResize}
            className="min-h-0 min-w-0"
          >
            {isNavCollapsed ? (
              <CollapsedNavRail onExpand={toggleCollapse} />
            ) : (
              <div className="h-full min-w-0 border-b border-border md:border-b-0 md:border-r">
                <TraceNavigation
                  run={liveRun}
                  isLive={isLive}
                  backHref={backHref}
                  backLabel={backLabel}
                  activeView={view}
                  onActiveViewChange={setView}
                  searchQuery={searchQuery}
                  onSearchQueryChange={setSearchQuery}
                  commentCounts={commentCounts}
                  prevId={prevId}
                  nextId={nextId}
                  onCollapse={toggleCollapse}
                />
              </div>
            )}
          </ResizablePanel>

          <ResizableHandle
            withHandle
            disableDoubleClick
            onDoubleClick={toggleCollapse}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                toggleCollapse();
              }
            }}
          />

          <ResizablePanel defaultSize="66%" minSize="25%" className="min-h-0 min-w-0">
            <TraceDetailPane mode={mode} onClose={onClose} />
          </ResizablePanel>
        </ResizablePanelGroup>
        )}
      </div>
      </ViewPreferencesProvider>
    </TraceDataProvider>
  );
}

export function TraceWorkspacePage({
  run,
  backHref = "/traces",
  backLabel = "Traces",
  className,
  adjacentPrevId = null,
  adjacentNextId = null,
}: {
  run: TraceDetail;
  backHref?: string;
  backLabel?: string;
  className?: string;
  adjacentPrevId?: string | null;
  adjacentNextId?: string | null;
}) {
  const router = useRouter();

  return (
    <div className={cn("h-full min-h-0", className)}>
      <TraceWorkspace
        run={run}
        mode="page"
        backHref={backHref}
        backLabel={backLabel}
        refreshRun={() => router.refresh()}
        prevId={adjacentPrevId}
        nextId={adjacentNextId}
        className="h-full"
      />
    </div>
  );
}
