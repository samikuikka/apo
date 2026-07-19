"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, ArrowLeft, Download, Settings2, ChevronLeft, ChevronRight, AlertTriangle, Globe, Lock, LinkIcon, Check, PanelLeft, Radio } from "lucide-react";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useProjectId } from "@/lib/project-router";
import { usePanelRef, type PanelSize } from "react-resizable-panels";
import { toast } from "sonner";
import { getCommentCounts } from "@/lib/comments-api";
import { toggleVisibility } from "@/lib/traces-api";
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
  /** Render an unauthenticated, view-only surface (public trace page):
   *  hides visibility toggle, prev/next nav, live streaming, and write
   *  affordances in the detail pane (bookmark/score/comment/correction). */
  readOnly?: boolean;
}

function downloadTrace(run: TraceDetail) {
  if (run.calls.length > 50) {
    toast.info(`Downloading trace with ${run.calls.length} observations`);
  }
  const data = { run: run.run, calls: run.calls, metrics: run.metrics };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `trace-${run.run.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function useCommentCounts(run: TraceDetail, readOnly = false) {
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const callIdKey = run.calls.map((c) => c.id).join(",");

  useEffect(() => {
    // Public/read-only views have no comment UI and the counts endpoint is
    // auth-gated, so skip the fetch entirely.
    if (readOnly) return;
    const runId = run.run.id;
    const callIds = callIdKey ? callIdKey.split(",") : [];
    const allIds = [runId, ...callIds];

    let cancelled = false;
    getCommentCounts(allIds, "trace").then((counts) => {
      if (!cancelled) setCommentCounts(counts);
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [readOnly, run.run.id, callIdKey]);

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

function VisibilityToggle({
  runId,
  isPublic,
  onToggle,
}: {
  runId: string;
  isPublic: boolean;
  onToggle: (isPublic: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleToggle = async () => {
    try {
      const result = await toggleVisibility(runId);
      onToggle(result.is_public);
    } catch {
      toast.error("Failed to toggle visibility");
    }
  };

  const handleCopyLink = async () => {
    const url = `${window.location.origin}/public/traces/${runId}`;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center gap-1">
      <Button
        variant={isPublic ? "default" : "outline"}
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        onClick={handleToggle}
        aria-label={isPublic ? "Make trace private" : "Make trace public"}
        type="button"
      >
        {isPublic ? <Globe className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
        {isPublic ? "Public" : "Private"}
      </Button>
      {isPublic && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={handleCopyLink}
          aria-label="Copy public link"
          type="button"
        >
          {copied ? <Check className="h-3 w-3" /> : <LinkIcon className="h-3 w-3" />}
          {copied ? "Copied" : "Copy link"}
        </Button>
      )}
    </div>
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
  isPublic,
  onVisibilityChange,
  readOnly = false,
}: {
  run: TraceDetail;
  isLive: boolean;
  backHref?: string;
  backLabel?: string;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  prevId: string | null;
  nextId: string | null;
  isPublic: boolean;
  onVisibilityChange: (isPublic: boolean) => void;
  readOnly?: boolean;
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
    if (readOnly) return;
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
  }, [readOnly, prevId, nextId]);

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

      {!readOnly && (
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
      )}

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

      {!readOnly && (
        <VisibilityToggle
          runId={run.run.id}
          isPublic={isPublic}
          onToggle={onVisibilityChange}
        />
      )}

      <ViewPreferencesDropdown />

      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        aria-label="Download trace as JSON"
        onClick={() => downloadTrace(run)}
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
  isPublic,
  onVisibilityChange,
  readOnly = false,
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
  isPublic: boolean;
  onVisibilityChange: (isPublic: boolean) => void;
  readOnly?: boolean;
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
          isPublic={isPublic}
          onVisibilityChange={onVisibilityChange}
          readOnly={readOnly}
        />
        <div className="px-2.5 pb-2 pt-0.5">
          <TraceNavTabs run={run} activeView={activeView} onActiveViewChange={onActiveViewChange} />
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

function TraceDetailPane({ mode, onClose, readOnly }: { mode: "page" | "panel"; onClose?: () => void; readOnly?: boolean }) {
  return (
    <div className="h-full min-h-0 min-w-0 overflow-auto bg-background">
      <TraceDetailView mode={mode} onClose={onClose} readOnly={readOnly} />
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
  readOnly = false,
}: TraceWorkspaceProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const [searchQuery, setSearchQuery] = useState(() =>
    mode === "page" ? (searchParams.get("q") ?? "") : "",
  );
  const lastSyncedQueryRef = useRef(searchQuery);
  const [isPublic, setIsPublic] = useState(run.run.is_public ?? false);
  const { view, setView } = useSelection();

  // Live streaming: overlay SSE span events onto the server-fetched calls so
  // the tree/gantt fill in while the trace is still running. The stream only
  // carries a sparse subset (timing/model/type), so we field-merge to avoid
  // clobbering rich input/output from the initial snapshot. When the trace
  // completes we do one final `refreshRun` to pull authoritative final state.
  // Skipped for read-only/public views: the stream endpoint requires auth and
  // public traces are served as a static snapshot.
  const traceCompleted = run.run.completed_at != null;
  const { calls: streamCalls, isLive } = useTraceStream(
    readOnly || traceCompleted ? null : run.run.id,
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
  const prevIsLiveRef = useRef(isLive);
  useEffect(() => {
    // The trace just completed: pull final state once so the detail pane gets
    // authoritative input/output/cost for every span.
    if (prevIsLiveRef.current && !isLive) {
      refreshRun?.();
    }
    prevIsLiveRef.current = isLive;
  }, [isLive, refreshRun]);

  const commentCounts = useCommentCounts(liveRun, readOnly);

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
    if (searchQuery === lastSyncedQueryRef.current) return;
    const timer = setTimeout(() => {
      lastSyncedQueryRef.current = searchQuery;
      const params = new URLSearchParams(searchParams.toString());
      if (searchQuery) {
        params.set("q", searchQuery);
      } else {
        params.delete("q");
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    }, 300);
    return () => clearTimeout(timer);
  }, [mode, searchQuery, searchParams, router, pathname]);

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
                isPublic={isPublic}
                onVisibilityChange={setIsPublic}
                readOnly={readOnly}
              />
            </div>
            <div className="min-h-0 flex-1">
              <TraceLayoutMobile
                tabs={<TraceNavTabs run={liveRun} activeView={view} onActiveViewChange={setView} />}
                navContent={
                  <TraceNavContent
                    run={liveRun}
                    activeView={view}
                    searchQuery={searchQuery}
                    commentCounts={commentCounts}
                  />
                }
                detailContent={<TraceDetailView mode={mode} onClose={onClose} readOnly={readOnly} />}
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
                  isPublic={isPublic}
                  onVisibilityChange={setIsPublic}
                  readOnly={readOnly}
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
            <TraceDetailPane mode={mode} onClose={onClose} readOnly={readOnly} />
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
