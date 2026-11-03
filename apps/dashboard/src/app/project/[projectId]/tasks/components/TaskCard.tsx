"use client";

import Link from "next/link";
import { BarChart3, Clock, DollarSign, Play } from "lucide-react";

import type {
  AgentTaskRunStats,
  AgentTaskSummary,
} from "@/lib/agent-task-api";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { formatCostMicro, parseUTC } from "@/lib/format";
import { useProjectId } from "@/lib/project-router";
import { hrefWithRunCohort, withViewId } from "@/lib/run-cohort";
import { useRunCohort, useRunCohortViewId } from "@/lib/run-cohort-context";
import { taskDetailHref } from "@/lib/task-routes";

import { PassBar } from "./PassBar";
import { Stat } from "./Stat";
import { STATUS_CONFIG, type TaskStatus } from "./task-list-shared";

export function TaskCard({
  task,
  isSel,
  status,
  stats,
  isDemoProject,
  toggleTask,
}: {
  task: AgentTaskSummary;
  isSel: boolean;
  status: TaskStatus;
  stats: AgentTaskRunStats | null;
  /** The demo capture is frozen: dates stay absolute and idle labels
   *  never promise a run an anonymous visitor cannot start. */
  isDemoProject: boolean;
  toggleTask: (id: string) => void;
}) {
  const projectId = useProjectId();
  // The active evidence view is a question ("what did this cohort do?"). The
  // task's stats already answer it scoped; carry the cohort into the detail
  // page so the run history answers the same question (Main = empty cohort).
  // The view identity rides along so the detail page can name the scope's
  // origin and the <- Tasks link can restore the tab.
  const cohort = useRunCohort();
  const viewId = useRunCohortViewId();
  const s = status !== "idle" ? STATUS_CONFIG[status] : null;
  const addedLabel = provenanceLabel(task);
  return (
    <Link
      href={withViewId(hrefWithRunCohort(taskDetailHref(projectId, task.id), cohort), viewId)}
      className={cn(
        "group/card relative block border px-2 py-3 transition-colors",
        isSel
          ? "border-foreground/30 bg-muted/30"
          : "border-border bg-card/60 hover:border-border hover:bg-card",
      )}
    >
      {isSel && (
        <span className="pointer-events-none absolute inset-y-2 left-0 w-[2px] bg-foreground/60" aria-hidden />
      )}
      <div className="flex items-start gap-3">
        <div
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          className="mt-1"
        >
          <Checkbox
            checked={isSel}
            onCheckedChange={() => toggleTask(task.id)}
            aria-label={`Select ${task.display_name}`}
          />
        </div>
        <div className="w-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {status !== "idle" ? (
              <>
                <span className={cn("h-2 w-2 rounded-full", s!.dot)} aria-hidden />
                <span className="truncate text-[14px] font-medium">{task.display_name}</span>
                <span className={cn("text-[11px] font-medium uppercase tracking-wide", s!.text)}>
                  {s!.label}
                </span>
              </>
            ) : (
              <span className="truncate text-[14px] font-medium text-muted-foreground">{task.display_name}</span>
            )}
            {task.tags.length > 0 && task.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>
            ))}
          </div>

          {addedLabel && (
            <div className="mt-1 min-w-0">
              <p className="text-[11px] text-muted-foreground/50">{addedLabel}</p>
            </div>
          )}

          {task.state === "removed" && (
            <p className="mt-0.5 text-[11px] text-muted-foreground/50">{removedLabel(task)}</p>
          )}

          {status === "idle" ? (
            <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted-foreground/50">
              <Play className="h-3 w-3" />
              <span>{notStartedLabel(stats?.not_started_runs ?? 0, isDemoProject)}</span>
              <span className="ml-auto font-mono text-[11px] text-muted-foreground/40">
                {relativePath(task.task_path)}
              </span>
            </div>
          ) : stats && stats.total_runs > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12px]">
              <Stat icon={BarChart3} label="Runs" value={`${stats.total_runs}`} />
              <Stat icon={Clock} label="Avg time" value={formatDuration(stats.avg_duration_ms)} />
              {stats.avg_cost !== null && stats.avg_cost > 0 && (
                <Stat icon={DollarSign} label="Avg cost" value={formatCostMicro(stats.avg_cost)} />
              )}
              <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
                <span className="text-muted-foreground/60">Last run</span>
                <span className="font-mono tabular-nums text-muted-foreground">{isDemoProject ? formatCaptureDate(stats.last_run_at) : formatRelativeTime(stats.last_run_at)}</span>
              </div>
              <span className="hidden font-mono text-[11px] text-muted-foreground/40 md:inline">
                {relativePath(task.task_path)}
              </span>
            </div>
          ) : null}
        </div>
        <div className="hidden shrink-0 items-center gap-2 text-[12px] text-muted-foreground sm:flex" style={{ width: "160px" }}>
          {stats && stats.total_runs > 0 && status !== "idle" && (
            <>
              <span className="text-muted-foreground/60">Pass</span>
              <div className="w-28">
                <PassBar value={stats.pass_rate} muted={status === "running"} />
              </div>
            </>
          )}
        </div>
      </div>
    </Link>
  );
}

/**
 * An archived card's one-line removal note: when it left the
 * catalog and — when the publishing CLI could see git — by which commit.
 * The date is unknown (not today) for removals that predate tombstones;
 * then the note says only what is honest.
 */
export function removedLabel(task: AgentTaskSummary): string {
  const when = task.removed_at ? new Date(task.removed_at).toISOString().slice(0, 10) : null;
  const sha = task.removed_commit_sha ? ` · publish ${task.removed_commit_sha.slice(0, 7)}` : "";
  return when ? `Removed ${when}${sha}` : "Removed from the catalog";
}

/** An idle task may still have runs that ended before starting (no executor
 * claimed them): say so rather than implying it was never tried. In a
 * read-only capture the zero-runs case must not promise a run. */
export function notStartedLabel(notStarted: number, readOnly = false): string {
  if (notStarted === 0) return readOnly ? "Not run in this capture" : "Ready to run";
  return notStarted === 1 ? "1 run never started" : `${notStarted} runs never started`;
}

/**
 * The card's quiet answer to "where did this task come from" (issue #444):
 * the first publication, with the publisher when the backend recorded one.
 */
export function provenanceLabel(task: AgentTaskSummary): string | null {
  if (!task.first_published_at) return null;
  const when = new Date(task.first_published_at).toISOString().slice(0, 10);
  const who = task.first_published_by;
  return who ? `Added ${when} by ${who}` : `Added ${when}`;
}

const TASK_ROOT = process.env.NEXT_PUBLIC_AGENT_TASK_ROOT ?? null;

function relativePath(path: string): string {
  if (!TASK_ROOT) return path;
  return path.startsWith(TASK_ROOT) ? path.slice(TASK_ROOT.length).replace(/^\//, "") : path;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "\u2014";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** The demo's "Last run" is a frozen capture date: an age like "59d ago"
 *  grows daily and reads as an abandoned project, so print the day itself
 *  (en-US short-month style, UTC, the same convention as run headers). */
const captureDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
});

function formatCaptureDate(dateStr: string | null): string {
  if (!dateStr) return "Never";
  return captureDateFormatter.format(parseUTC(dateStr));
}
