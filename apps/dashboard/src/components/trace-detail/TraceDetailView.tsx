"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useTraceData } from "./contexts/TraceDataContext";
import { useSelection } from "./contexts/SelectionContext";
import { CallDetailView } from "./CallDetailView";
import { TraceDetailTabs } from "./TraceDetailTabs";
import { ScoreInputPanel } from "./ScoreInputPanel";
import { RunCostBreakdownTooltip } from "./DimensionBreakdownTooltip";
import { CommentDrawer } from "./CommentDrawer";
import { HeaderPill } from "./HeaderPill";
import { formatDate, formatMetaParts } from "./call-detail-utils";
import { toggleBookmark } from "@/lib/traces-api";
import { useProjectId } from "@/lib/project-router";
import { taskDetailHref } from "@/lib/task-routes";
import { Star, X, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { formatCostMicro, formatDuration, formatTokenTotal } from "@/lib/format";

export function TraceDetailView({
  mode,
  onClose,
}: {
  mode?: "page" | "panel";
  onClose?: () => void;
}) {
  const { run } = useTraceData();
  const { selectedCallId } = useSelection();

  if (!run) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-muted-foreground">No data available</p>
      </div>
    );
  }

  if (selectedCallId) {
    const call = run.calls.find((c) => c.id === selectedCallId);
    if (!call) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <p className="text-muted-foreground">Call not found</p>
        </div>
      );
    }
    return <CallDetailView call={call} />;
  }

  return <TraceDetailRootView run={run} mode={mode} onClose={onClose} />;
}

function TraceDetailRootView({
  run,
  mode,
  onClose,
}: {
  run: any;
  mode?: "page" | "panel";
  onClose?: () => void;
}) {
  const projectId = useProjectId();
  const { refreshRun } = useTraceData();
  const [showScorePanel, setShowScorePanel] = useState(false);
  const [bookmarked, setBookmarked] = useState<boolean>(run.run.bookmarked ?? false);
  const totalCost = run.calls.reduce((sum: number, c: any) => sum + (c.cost || 0), 0);
  const totalTokens = run.calls.reduce((sum: number, c: any) => sum + (c.total_tokens || 0), 0);
  const summaryParts = formatMetaParts([
    run.run.duration_ms != null ? formatDuration(run.run.duration_ms) : null,
    totalCost > 0 ? formatCostMicro(totalCost) : null,
    totalTokens > 0 ? formatTokenTotal(totalTokens) : null,
    `${run.run.call_count} calls`,
    run.run.project ? `project ${run.run.project}` : null,
  ]);

  const handleToggleBookmark = useCallback(async () => {
    try {
      const result = await toggleBookmark(run.run.id);
      setBookmarked(result.bookmarked);
    } catch (err) {
      console.error("Failed to toggle bookmark:", err);
    }
  }, [run.run.id]);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="shrink-0 space-y-2 border-b p-3">
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium">
            {run.run.scopeKey || run.run.task_id || "Untitled trace"}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {mode === "panel" && (
              <Link
                href={`/project/${projectId}/traces/${run.run.id}`}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
                aria-label="Open trace in full page"
                title="Open in full page"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            )}
            {mode === "panel" && onClose && (
              <button
                type="button"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
                onClick={onClose}
                aria-label="Close trace panel"
              >
                <X className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center transition-colors hover:bg-muted/50"
              onClick={handleToggleBookmark}
              aria-label={bookmarked ? "Remove bookmark" : "Add bookmark"}
            >
              <Star
                className={cn(
                  "h-4 w-4 transition-colors",
                  bookmarked ? "fill-warning text-warning" : "text-muted-foreground hover:text-foreground",
                )}
              />
            </button>
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          {formatDate(run.run.created_at)}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {summaryParts.map((part) => {
            const isCost = part.startsWith("$");
            const pill = (
              <HeaderPill key={part} mono={isCost || part.includes("tok")}>
                {part}
              </HeaderPill>
            );
            if (isCost && totalCost > 0) {
              return (
                <RunCostBreakdownTooltip key={part} calls={run.calls}>
                  {pill}
                </RunCostBreakdownTooltip>
              );
            }
            return pill;
          })}
          {run.run.task_id && (
            <Link
              href={taskDetailHref(run.run.project, run.run.task_id)}
              className="inline-flex items-center border border-border/70 px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {run.run.task_id}
            </Link>
          )}
          {run.run.version && <HeaderPill mono>{run.run.version}</HeaderPill>}
          {run.run.environment && run.run.environment !== "default" && <HeaderPill>env: {run.run.environment}</HeaderPill>}
          {run.run.session_id && <HeaderPill mono>session: {run.run.session_id.length > 12 ? `${run.run.session_id.slice(0, 12)}...` : run.run.session_id}</HeaderPill>}
          <Button
            type="button"
            variant={showScorePanel ? "secondary" : "outline"}
            size="xs"
            onClick={() => setShowScorePanel(!showScorePanel)}
          >
            <Star className="h-3 w-3" />
            Score
          </Button>
          <CommentDrawer
            objectId={run.run.id}
            objectType="trace"
            projectId={run.run.project}
           />
        </div>
        {showScorePanel && (
          <div className="mt-2 border border-border bg-muted/30">
            <ScoreInputPanel
              targetType="trace"
              targetId={run.run.id}
              onScoreCreated={refreshRun}
            />
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <TraceDetailTabs run={run} />
      </div>
    </div>
  );
}
