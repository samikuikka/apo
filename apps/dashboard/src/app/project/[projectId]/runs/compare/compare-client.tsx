"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Clock,
  GitCompare,
} from "lucide-react";

import {
  type AgentTaskBatchRunDetail,
  type AgentTaskBatchRunSummary,
  type AgentTaskRunSummary,
  type AgentTaskSummary,
} from "@/lib/agent-task-api";
import { cn } from "@/lib/utils";
import { formatDuration, formatRelativeTime, runDurationMs, formatCostMicro } from "@/lib/format";
import { useUrlParamSet } from "@/hooks/use-url-state";
import { conclusionStyle } from "@/components/run-outcome";

import { useComparison, tallyChecks, type CheckTally } from "./use-comparison";
import { FlowSection } from "./components/FlowSection";

interface CompareClientProps {
  projectId: string;
  batchA: AgentTaskBatchRunDetail | null;
  batchB: AgentTaskBatchRunDetail | null;
  inventory: AgentTaskSummary[];
  leftRuns: AgentTaskRunSummary[];
  rightRuns: AgentTaskRunSummary[];
}

/** Most common primary_model across a batch's runs — "mixed" if there is no
 *  single dominant model. Used only as a label in the header, never as a
 *  comparison key. */
function dominantModel(runs: AgentTaskRunSummary[]): string | null {
  const counts = new Map<string, number>();
  for (const r of runs) {
    if (r.primary_model) counts.set(r.primary_model, (counts.get(r.primary_model) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  if (counts.size === 1) return counts.keys().next().value ?? null;
  // More than one model: report the most frequent, flagged as mixed.
  let best: string | null = null;
  let bestN = 0;
  for (const [m, n] of counts) {
    if (n > bestN) {
      best = m;
      bestN = n;
    }
  }
  return best;
}

function shortModel(model: string | null): string {
  if (!model) return "—";
  // Provider-prefixed names ("openai/gpt-4o") read better without the prefix.
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/** A meaningful identity for a batch in lists where the model may be
 *  unknown. Mirrors the /runs page's getBatchName: prefer the task
 *  selection label, fall back to the selection type. */
function batchLabel(batch: AgentTaskBatchRunDetail | AgentTaskBatchRunSummary): string {
  const q = batch.selection_query;
  if (q && typeof q === "object" && "task_paths" in q) {
    const paths = q.task_paths;
    if (Array.isArray(paths) && paths.length > 0) {
      if (paths.length === 1) {
        const seg = String(paths[0]).split("/").pop();
        return seg ?? String(paths[0]);
      }
      return `${paths.length} tasks`;
    }
  }
  if (batch.selection_type === "all") return "All tasks";
  return batch.selection_type;
}

export function CompareClient({
  projectId,
  batchA,
  batchB,
  inventory,
  leftRuns,
  rightRuns,
}: CompareClientProps) {
  const [expanded, toggleExpanded] = useUrlParamSet("expand");

  const comparison = useComparison(leftRuns, rightRuns, inventory);

  // The comparison's job is to show what CHANGED between two runs. Identical
  // tasks (same verdict, same check breakdown on both sides) carry no signal,
  // so they're always hidden. A task present in only one batch IS a change
  // (it appeared or disappeared), so one-sided rows stay visible. There used
  // to be a "hide identical" toggle for this, but the toggled-off state — a
  // full aligned list where 95% of rows are identical — isn't useful in a
  // comparison, so the toggle is gone.
  const foldersToShow = useMemo(() => {
    return comparison.folders.flatMap((f) => {
      const tasks = f.tasks.filter((t) => t.differs || t.left.run === null || t.right.run === null);
      return tasks.length > 0 ? [{ ...f, tasks }] : [];
    });
  }, [comparison.folders]);

  return (
    <div className="mx-auto w-full max-w-6xl">
      <CompareHeader projectId={projectId} />

      <div className="border-b border-border bg-background px-6 py-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <BatchSlot
            label="Run A"
            batch={batchA}
            runs={leftRuns}
            projectId={projectId}
          />
          <BatchSlot
            label="Run B"
            batch={batchB}
            runs={rightRuns}
            projectId={projectId}
          />
        </div>

        {batchA && batchB && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
            {comparison.totalDiffers > 0 ? (
              <span>
                <span className="font-mono tabular-nums text-foreground">{comparison.totalDiffers}</span>{" "}
                of{" "}
                <span className="font-mono tabular-nums text-foreground">{comparison.tasks.length}</span>{" "}
                tasks differ
              </span>
            ) : (
              <span>No tasks differ between these runs</span>
            )}
            {comparison.totalOnlyInOne > 0 && (
              <span className="text-muted-foreground/60">
                {" · "}
                <span className="font-mono tabular-nums">{comparison.totalOnlyInOne}</span> task{comparison.totalOnlyInOne > 1 ? "s" : ""} only in one run
              </span>
            )}
            {/* Graded signal (belief #5): the check tally delta is what tells
                you whether things improved or regressed, even when every task
                failed on both sides. Surfaced as a fact (the numbers), never
                a directional verdict — the reader judges the trajectory. */}
            {comparison.leftChecks.total > 0 && comparison.rightChecks.total > 0 && (
              <CheckDelta
                left={comparison.leftChecks}
                right={comparison.rightChecks}
              />
            )}
          </div>
        )}
      </div>

      {!batchA || !batchB ? (
        <div className="m-6 rounded-md border border-dashed border-border bg-card/40 p-10 text-center text-[13px] text-muted-foreground">
          <GitCompare className="mx-auto mb-2 h-5 w-5 text-muted-foreground/50" />
          {batchA || batchB
            ? "Select a second run to compare."
            : "Select two runs to compare."}
        </div>
      ) : comparison.tasks.length === 0 ? (
        <div className="m-6 rounded-md border border-dashed border-border bg-card/40 p-10 text-center text-[13px] text-muted-foreground">
          These runs share no tasks — there is nothing to compare.
        </div>
      ) : (
        <>
          <div className="divide-y divide-border">
            {foldersToShow.map((f) => (
              <FlowSection
                key={f.folder}
                folder={f.folder}
                tasks={f.tasks}
                differsCount={f.tasks.filter((t) => t.differs).length}
                leftChecks={tallyChecks(f.tasks.map((t) => t.left))}
                rightChecks={tallyChecks(f.tasks.map((t) => t.right))}
                defaultOpen={f.tasks.some((t) => t.differs)}
                expanded={expanded}
                onToggleExpand={toggleExpanded}
                projectId={projectId}
              />
            ))}
            {foldersToShow.length === 0 && (
              <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
                No differing tasks — all aligned tasks are identical.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function CompareHeader({ projectId }: { projectId: string }) {
  return (
    <div className="border-b border-border bg-background">
      <div className="flex items-center gap-1.5 px-6 py-5 text-[12px] text-muted-foreground">
        <Link href={`/project/${projectId}/runs`} className="inline-flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Runs
        </Link>
        <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
        <span className="text-foreground">Compare</span>
      </div>
    </div>
  );
}

/** One side of the comparison header: a batch summary, or a "pick a run"
 *  prompt when that side is unset. The pick prompt fetches recent batches. */
function BatchSlot({
  label,
  batch,
  runs,
  projectId,
}: {
  label: string;
  batch: AgentTaskBatchRunDetail | null;
  runs: AgentTaskRunSummary[];
  projectId: string;
}) {
  if (!batch) {
    // Reaching compare without both sides set happens when navigating directly
    // or via the old single-compare link. Point back to the runs page, where
    // runs are picked with overlap in context — not in a blind picker here.
    return (
      <div className="rounded-md border border-dashed border-border bg-card/40 p-4">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
        <Link
          href={`/project/${projectId}/runs`}
          className="mt-1 inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
        >
          Choose a run on the Runs page…
        </Link>
      </div>
    );
  }

  // Pass rate is check-level (Σ passed_checks / Σ total_checks) — "how well
  // did it do". The task-level fraction is shown beside it as the binary
  // "did every task fully pass" signal. Belief #5: two failed batches are
  // not equal — 10/21 checks vs 8/21 is a real difference the binary task
  // pass-rate (0% for both) hides. Mirrors runs-client.tsx:477-484.
  const checkTotal = Math.max(batch.total_checks, 1);
  const passRate = Math.round((batch.passed_checks / checkTotal) * 100);
  const hasChecks = batch.total_checks > 0;
  const s = conclusionStyle({
    status: batch.status,
    passed: batch.passed_tasks,
    failed: batch.failed_tasks,
    errored: batch.errored_tasks,
    total: batch.total_tasks,
  });
  const model = dominantModel(runs);
  const commit = batch.task_runs?.[0]?.task_source_commit_sha ?? null;

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={cn("h-2 w-2 rounded-full", s.dot)} aria-hidden />
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
        </div>
        <Link
          href={`/project/${projectId}/runs`}
          className="text-[11px] text-muted-foreground/70 hover:text-foreground"
        >
          Change
        </Link>
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-[15px] font-medium text-foreground">{batchLabel(batch)}</span>
        {model && (
          <span className="font-mono text-[12px] tabular-nums text-muted-foreground">{shortModel(model)}</span>
        )}
        <span className="font-mono text-[12px] text-muted-foreground/60">#{batch.id.slice(0, 8)}</span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
        <span>{formatRelativeTime(batch.created_at)}</span>
        {commit && (
          <span className="font-mono text-[11px] text-muted-foreground/60">@{commit.slice(0, 7)}</span>
        )}
        {batch.trigger?.branch && (
          <span className="font-mono text-[11px] text-muted-foreground/60">{batch.trigger.branch}</span>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <span
          className={cn(
            "font-mono text-[18px] font-semibold tabular-nums",
            passRate >= 95 ? "text-success" : passRate < 80 ? "text-destructive" : "text-foreground",
          )}
        >
          {hasChecks ? `${passRate}%` : "—"}
        </span>
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-border">
          <div
            className={cn("h-full", passRate >= 95 ? "bg-success" : passRate < 80 ? "bg-destructive" : "bg-foreground/30")}
            style={{ width: `${passRate}%` }}
          />
        </div>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {hasChecks ? `${batch.passed_checks}/${batch.total_checks} checks` : "no checks"}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground/60">
          · {batch.passed_tasks}/{batch.total_tasks} tasks
        </span>
        {/* Cost + duration sit together on the right — the two "what did this
            run cost me" summary stats. Duration is the gap that was missing
            (the runs page shows it; compare didn't). Hidden when absent. */}
        <div className="ml-auto flex items-center gap-3 font-mono text-[11px] tabular-nums text-muted-foreground">
          {(() => {
            const ms = runDurationMs(batch.started_at, batch.completed_at);
            return ms != null ? (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3 text-muted-foreground/50" />
                {formatDuration(ms)}
              </span>
            ) : null;
          })()}
          {batch.total_cost != null && batch.total_cost > 0 && (
            <span>{formatCostMicro(batch.total_cost)}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Aggregate check-delta between the two batches — the load-bearing graded
 *  signal of belief #5. Shows the Σ check tallies as "10/21 → 8/21 (−2)",
 *  a fact about two runs. The delta is colored only to draw the eye to a
 *  meaningful change; the reader judges whether it's a regression or
 *  improvement in context. */
function CheckDelta({ left, right }: { left: CheckTally; right: CheckTally }) {
  const delta = right.passed - left.passed;
  const sign = delta > 0 ? "+" : "";
  // Only flag a change when it's non-zero AND both sides actually ran checks.
  const hasChange = delta !== 0;
  return (
    <span className="font-mono tabular-nums">
      <span className="text-muted-foreground/60">· checks </span>
      <span className="text-muted-foreground">
        {left.passed}/{left.total}
      </span>
      <span className="text-muted-foreground/40"> → </span>
      <span className="text-muted-foreground">
        {right.passed}/{right.total}
      </span>
      {hasChange && (
        <span
          className={cn(
            "ml-1",
            delta > 0 ? "text-success" : "text-destructive",
          )}
        >
          ({sign}
          {delta})
        </span>
      )}
    </span>
  );
}
