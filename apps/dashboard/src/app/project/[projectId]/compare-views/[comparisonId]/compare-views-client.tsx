"use client";

// Comparison page — renders the SAME task-level comparison as
// /runs/compare (useComparison + FlowSection), fed by the resolved run_ids
// from the immutable view snapshot. The only structural difference is the
// header: view configs (Model · Effort · Date) instead of batch summaries.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";

import type { AgentTaskRunSummary, AgentTaskSummary } from "@/lib/agent-task-api";
import type { ComparisonState, TaskComparisonEvidenceLoader, TaskViewComparisonSnapshot, TaskViewConfig } from "@/lib/agent-task-view-api";
import { getTaskComparisonEvidence } from "@/lib/agent-task-view-api";
import { cn } from "@/lib/utils";
import { useUrlParam } from "@/hooks/use-url-state";
import {
  servingIdentityLabel,
  type ServingFilter,
  type ServingSummary as ServingSummaryData,
} from "@/lib/serving-types";

import { useComparison } from "../../runs/compare/use-comparison";
import { CheckDelta } from "../../runs/compare/compare-client";
import { FlowSection } from "../../runs/compare/components/FlowSection";


export function CompareViewsClient({
  projectId,
  comparisonId,
  snapshot,
  tasks,
  leftRuns,
  rightRuns,
  stateByTask,
}: {
  projectId: string;
  comparisonId: string;
  snapshot: TaskViewComparisonSnapshot;
  tasks: AgentTaskSummary[];
  leftRuns: AgentTaskRunSummary[];
  rightRuns: AgentTaskRunSummary[];
  stateByTask?: Map<string, ComparisonState>;
}) {
  // Single active task — opening one task closes the previous so
  // only one evidence pair is in memory at a time. The expand URL param holds
  // one task id; a legacy comma-separated value opens only the first and is
  // rewritten to the canonical single value on load.
  const [activeTaskId, setActiveTaskId] = useUrlParam("expand");
  const firstLegacyTask = activeTaskId.split(",")[0]?.trim() || "";
  useEffect(() => {
    if (activeTaskId && activeTaskId !== firstLegacyTask) {
      setActiveTaskId(firstLegacyTask || null);
    }
  }, [activeTaskId, firstLegacyTask, setActiveTaskId]);
  const expanded = useMemo(
    () => (firstLegacyTask ? new Set([firstLegacyTask]) : new Set<string>()),
    [firstLegacyTask],
  );
  const toggleExpanded = useCallback(
    (taskId: string) => {
      setActiveTaskId(firstLegacyTask === taskId ? null : taskId);
    },
    [firstLegacyTask, setActiveTaskId],
  );
  const comparison = useComparison(leftRuns, rightRuns, tasks, stateByTask);
  const [hideErrored, setHideErrored] = useState(false);

  // Progressive evidence loader. Only one task is active at a time;
  // FlowSection passes it down so CompareTaskRow fetches details on expand.
  const evidenceLoader: TaskComparisonEvidenceLoader = useCallback(
    (taskId: string, signal: AbortSignal) =>
      getTaskComparisonEvidence(projectId, comparisonId, taskId, signal).then(
        (e) => ({ left: e.left, right: e.right }),
      ),
    [projectId, comparisonId],
  );

  const foldersToShow = useMemo(() => {
    if (!hideErrored) return comparison.folders;
    return comparison.folders.flatMap((folder) => {
      const tasks = folder.tasks.filter(
        (task) => task.left.run?.status !== "error" && task.right.run?.status !== "error",
      );
      return tasks.length > 0 ? [{ ...folder, tasks }] : [];
    });
  }, [comparison.folders, hideErrored]);

  return (
    <div className="mx-auto w-full max-w-6xl">
      {/* Breadcrumb */}
      <div className="border-b border-border bg-background">
        <div className="flex items-center gap-1.5 px-6 py-5 text-[12px] text-muted-foreground">
          <Link href={`/project/${projectId}/tasks`} className="inline-flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="h-3 w-3" /> Tasks
          </Link>
          <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
          <span className="text-foreground">Compare views</span>
        </div>
      </div>

      {/* Header: both view configs + summary in one clean line */}
      <div className="border-b border-border bg-background px-6 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
          <span className="font-mono text-[13px] text-foreground">{viewLabel(snapshot.view_a_config)}</span>
          {frozenServingNote(snapshot, "a") && (
            <span className="font-mono text-[11px] text-muted-foreground/70">
              {frozenServingNote(snapshot, "a")}
            </span>
          )}
          <span className="text-muted-foreground/40">vs</span>
          <span className="font-mono text-[13px] text-foreground">{viewLabel(snapshot.view_b_config)}</span>
          {frozenServingNote(snapshot, "b") && (
            <span className="font-mono text-[11px] text-muted-foreground/70">
              {frozenServingNote(snapshot, "b")}
            </span>
          )}
          <span className="text-muted-foreground/30">·</span>
          {comparison.totalDiffers > 0 ? (
            <span>
              <span className="font-mono tabular-nums text-foreground">{comparison.totalDiffers}</span>{" "}
              of{" "}
              <span className="font-mono tabular-nums text-foreground">{comparison.tasks.length}</span>{" "}
              tasks differ
            </span>
          ) : (
            <span>No tasks differ between these views</span>
          )}
          {comparison.totalOnlyInOne > 0 && (
            <span className="text-muted-foreground/60">
              <span className="font-mono tabular-nums">{comparison.totalOnlyInOne}</span> only in one view
            </span>
          )}
          {comparison.leftChecks.total > 0 && comparison.rightChecks.total > 0 && (
            <CheckDelta left={comparison.leftChecks} right={comparison.rightChecks} />
          )}
          <button
            type="button"
            onClick={() => setHideErrored((v) => !v)}
            className={cn(
              "ml-auto border px-2 py-0.5 text-[11px] transition-colors",
              hideErrored
                ? "border-foreground/30 bg-foreground/10 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {hideErrored ? "✓ Hide errored" : "Hide errored"}
          </button>
        </div>
      </div>

      {/* Task rows — same FlowSection rendering as /runs/compare */}
      {comparison.tasks.length === 0 ? (
        <div className="m-6 border border-dashed border-border bg-card/40 p-10 text-center text-[13px] text-muted-foreground">
          These views share no tasks — there is nothing to compare.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {foldersToShow.map((f) => (
            <FlowSection
              key={f.folder}
              folder={f.folder}
              tasks={f.tasks}
              differsCount={f.tasks.filter((t) => t.differs).length}
              defaultOpen={f.tasks.some((t) => t.differs)}
              expanded={expanded}
              onToggleExpand={toggleExpanded}
              projectId={projectId}
              evidenceLoader={evidenceLoader}
            />
          ))}
          {foldersToShow.length === 0 && hideErrored && (
            <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
              All compared tasks are errored and currently hidden.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function viewLabel(view: TaskViewConfig): string {
  const parts = [view.model ?? "All models"];
  if (view.effort) parts.push(view.effort);
  if (view.since) parts.push(view.since);
  const serving = servingFilterLabel(view.serving_filter ?? null);
  if (serving) parts.push(serving);
  return parts.join(" \u00b7 ");
}

/** The frozen serving filter as one compact label (issue #307). Values OR
 * within a dimension, dimensions AND; the label just lists them. */
function servingFilterLabel(filter: ServingFilter | null): string | null {
  if (!filter) return null;
  const dims: string[] = [];
  if (filter.observed_models.length > 0) dims.push(filter.observed_models.join("/"));
  if (filter.providers.length > 0) dims.push(filter.providers.join("/"));
  if (filter.hosts.length > 0) dims.push(filter.hosts.join("/"));
  if (filter.routes.length > 0) dims.push(filter.routes.join("/"));
  if (filter.service_tiers.length > 0) dims.push(filter.service_tiers.join("/"));
  const unknown = filter.unknown.length > 0 ? `unknown:${filter.unknown.join(",")}` : null;
  if (unknown) dims.push(unknown);
  if (dims.length === 0) return null;
  return `serving ${dims.join(" + ")}${filter.mode === "only" ? " only" : ""}`;
}

/** One side's frozen serving evidence, as counting only (issue #307): how
 * many of the side's resolved runs carried evidence and how many distinct
 * setups they served under. Pure counts over the frozen summaries — no
 * per-host verdict attribution. Null (renders nothing) when the snapshot
 * predates the feature or the side's runs carried no evidence. */
function frozenServingNote(
  snapshot: TaskViewComparisonSnapshot,
  side: "a" | "b",
): string | null {
  const summaries: ServingSummaryData[] = [];
  let runs = 0;
  for (const cell of snapshot.resolved) {
    const runId = side === "a" ? cell.a_run_id : cell.b_run_id;
    if (runId == null) continue;
    runs += 1;
    const summary = side === "a" ? cell.a_serving : cell.b_serving;
    if (summary != null) summaries.push(summary);
  }
  if (summaries.length === 0) return null;
  const setups = new Set<string>();
  let uniform = true;
  for (const summary of summaries) {
    if (summary.state !== "uniform") uniform = false;
    for (const group of summary.groups) {
      setups.add(servingIdentityLabel(group.identity));
    }
  }
  // Every run reporting the same single setup collapses to that setup's
  // label; anything less agrees on is shown as counts.
  const allSame = uniform && setups.size === 1 && summaries.every((s) => s.total_groups === 1);
  if (allSame) {
    const label = [...setups][0] ?? null;
    if (label) return `served by ${label}`;
  }
  const distinct = setups.size;
  return `${summaries.length}/${runs} runs with evidence \u00b7 ${distinct} setup${distinct === 1 ? "" : "s"}`;
}
