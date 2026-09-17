"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Brain,
  ChevronRight,
  Clock,
  Folder,
  Gauge,
  GitCompare,
  Hash,
} from "lucide-react";
import { useEffect } from "react";

import {
  type AgentTaskBatchRunDetail,
  type AgentTaskBatchRunSummary,
  type AgentTaskRunSummary,
  type AgentTaskSummary,
} from "@/lib/agent-task-api";
import { cn } from "@/lib/utils";
import { formatDuration, formatRelativeTime, runDurationMs, formatCostMicro, tokenFormat, formatTokenTotal } from "@/lib/format";
import { formatBatchExecution, shortModel } from "@/lib/run-configuration";
import { useUrlParamSet } from "@/hooks/use-url-state";
import { conclusionStyle } from "@/components/run-outcome";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { useComparison, tallyChecks, type CheckTally } from "./use-comparison";
import { FlowSection } from "./components/FlowSection";
import { TaskColumns } from "./components/TaskColumns";

interface CompareClientProps {
  projectId: string;
  batchA: AgentTaskBatchRunDetail | null;
  batchB: AgentTaskBatchRunDetail | null;
  inventory: AgentTaskSummary[];
  leftRuns: AgentTaskRunSummary[];
  rightRuns: AgentTaskRunSummary[];
  /** PROTOTYPE — ?aggregate=1 enables the Tasks/Summary tab split. */
  showAggregate?: boolean;
  tab?: "tasks" | "summary";
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

/**
 * name the configuration dimensions that differ between two
 * uniform batches. Returns a label like `"Changed: effort"` or `null` when
 * the two are equivalent, or when either side is not a single uniform pair
 * (mixed/partial/unknown are already labeled honestly on each header).
 */
function configurationDelta(
  a: AgentTaskBatchRunDetail | null,
  b: AgentTaskBatchRunDetail | null,
): string | null {
  if (!a || !b) return null;
  if (a.configuration.state !== "uniform" || b.configuration.state !== "uniform") return null;
  const pa = a.configuration.configurations[0];
  const pb = b.configuration.configurations[0];
  if (!pa || !pb) return null;
  const changed: string[] = [];
  if (pa.model !== pb.model) changed.push("model");
  if ((pa.effort ?? null) !== (pb.effort ?? null)) changed.push("effort");
  return changed.length > 0 ? `Changed: ${changed.join(", ")}` : null;
}

export function CompareClient({
  projectId,
  batchA,
  batchB,
  inventory,
  leftRuns,
  rightRuns,
  showAggregate = false,
  tab = "tasks",
}: CompareClientProps) {
  const [expanded, toggleExpanded] = useUrlParamSet("expand");

  const comparison = useComparison(leftRuns, rightRuns, inventory);

  // A comparison is an evidence view, not a diff-only report. Keep every
  // aligned task visible: equal verdicts can still hide meaningful differences
  // in output, judge reasoning, trace shape, latency, tokens, and cost.
  const foldersToShow = comparison.folders;

  // The working view (Tasks) stays exactly as it has always been; the
  // aggregate lives on its own tab so neither competes for the same pixels.
  const summaryActive = showAggregate && tab === "summary" && batchA && batchB;
  const tabsActive = Boolean(showAggregate && batchA && batchB);

  return (
    <div className="mx-auto w-full max-w-6xl">
      <CompareHeader projectId={projectId} />

      <div className="border-b border-border bg-background px-6 py-4">
        {tabsActive ? <CompareTabs tab={tab} /> : null}

        {summaryActive ? (
          <SummaryView
            batchA={batchA}
            batchB={batchB}
            projectId={projectId}
            tasks={comparison.tasks}
            leftChecks={comparison.leftChecks}
            rightChecks={comparison.rightChecks}
            leftRuns={leftRuns}
            rightRuns={rightRuns}
          />
        ) : (
          <>
        {tabsActive && batchA && batchB ? (
          <MinimalPickers batchA={batchA} batchB={batchB} projectId={projectId} />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <BatchSlot
              label="Run A"
              batch={batchA}
              projectId={projectId}
            />
            <BatchSlot
              label="Run B"
              batch={batchB}
              projectId={projectId}
            />
          </div>
        )}

        {batchA && batchB && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
            {/* which configuration dimension changed between runs. */}
            {configurationDelta(batchA, batchB) && (
              <span className="font-mono text-foreground">
                {configurationDelta(batchA, batchB)}
              </span>
            )}
            {tabsActive ? (
              comparison.totalDiffers > 0 ? (
                <span>
                  <span className="font-mono tabular-nums text-foreground">{comparison.totalDiffers}</span>{" "}
                  of{" "}
                  <span className="font-mono tabular-nums text-foreground">{comparison.tasks.length}</span>{" "}
                  tasks changed
                </span>
              ) : (
                <span>No tasks changed between these runs</span>
              )
            ) : comparison.totalDiffers > 0 ? (
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
                a directional verdict — the reader judges the trajectory.
                Prototype mode keeps this off the working view — the Summary
                tab carries the tallies. */}
            {!tabsActive && comparison.leftChecks.total > 0 && comparison.rightChecks.total > 0 && (
              <CheckDelta
                left={comparison.leftChecks}
                right={comparison.rightChecks}
              />
            )}
          </div>
        )}
          </>
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
      ) : summaryActive ? null : (
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
                compact={tabsActive}
              />
            ))}
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

/** PROTOTYPE — the Tasks/Summary split. The working view keeps its density;
 *  aggregate stats live on their own tab so neither competes for pixels
 *  (Braintrust's List/Summary layout switcher is the precedent). */
function CompareTabs({ tab }: { tab: "tasks" | "summary" }) {
  const router = useRouter();
  const setTab = (v: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set("tab", v);
    router.replace(`?${params.toString()}`, { scroll: false });
  };
  return (
    <div className="-mt-1 mb-4">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-9 bg-card">
          <TabsTrigger value="tasks" className="px-4 text-[13px]">Tasks</TabsTrigger>
          <TabsTrigger value="summary" className="px-4 text-[13px]">Summary</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}

/** One side of the comparison header: a batch summary, or a "pick a run"
 *  prompt when that side is unset. The pick prompt fetches recent batches. */
function BatchSlot({
  label,
  batch,
  projectId,
}: {
  label: string;
  batch: AgentTaskBatchRunDetail | null;
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
  // the header shows the adapter-reported Run Configuration summary
  // (uniform/mixed/partial/unknown), replacing the old dominantModel
  // heuristic that guessed a single model from observed trace data.
  const executionLabel = formatBatchExecution(batch.configuration);
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
        <span className="font-mono text-[12px] tabular-nums text-muted-foreground" title="Adapter-reported configuration">
          {executionLabel}
        </span>
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
            <span>
              {formatCostMicro(batch.total_cost)}
              {(batch.unpriced_call_count ?? 0) > 0 && (
                <span
                  className="ml-1 text-warning"
                  title={`${batch.unpriced_call_count} call${batch.unpriced_call_count === 1 ? "" : "s"} had no pricing entry — this total is partial`}
                >
                  +{batch.unpriced_call_count} unpriced
                </span>
              )}
            </span>
          )}
          {batch.total_tokens != null && batch.total_tokens > 0 && (
            <span className="inline-flex items-center gap-1">
              <Hash className="h-3 w-3 text-muted-foreground/50" />
              {formatTokenTotal(batch.total_tokens)}
            </span>
          )}
          {/* Issue #309: reasoning + model time beside tokens in the "what
              did this run cost me" cluster. Null = unknown (no child
              reported) → hidden, never rendered as zero. */}
          {batch.total_reasoning_tokens != null && (
            <span
              className="inline-flex items-center gap-1"
              title="Sum of reasoning tokens across runs that reported the dimension"
            >
              <Brain className="h-3 w-3 text-muted-foreground/50" />
              {formatTokenTotal(batch.total_reasoning_tokens)}
            </span>
          )}
          {batch.total_model_time_ms != null && (
            <span
              className="inline-flex items-center gap-1"
              title="Sum of model-call latencies — tool and harness time excluded"
            >
              <Gauge className="h-3 w-3 text-muted-foreground/50" />
              {formatDuration(batch.total_model_time_ms)}
            </span>
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
export function CheckDelta({ left, right }: { left: CheckTally; right: CheckTally }) {
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


// PROTOTYPE — aggregate strip (?aggregate=1). Pure counting over data the
// page already loaded: column totals, flip directions, graded check signal.
// No averaging: binary verdicts counted, errors kept separate, checks X/Y.
type CompareTasks = { left: { run: AgentTaskRunSummary | null }; right: { run: AgentTaskRunSummary | null } }[];

function verdictCounts(tasks: CompareTasks) {
  let same = 0;
  let fixed = 0;
  let broke = 0;
  let compared = 0;
  for (const t of tasks) {
    const l = t.left.run;
    const r = t.right.run;
    if (!l || !r) continue;
    compared += 1;
    const lp = l.status === "passed";
    const rp = r.status === "passed";
    if (lp === rp) same += 1;
    else if (rp) fixed += 1;
    else broke += 1;
  }
  return { same, fixed, broke, compared };
}

/** The one-line pair verdict shared by the prototype headers: what B did,
 *  what didn't change, how far the work moved, what it cost. Says only
 *  things true of the PAIR — per-side facts live in the side columns. */
function VerdictSentence({
  tasks,
  leftChecks,
  rightChecks,
  costA,
  costB,
  onlyInOne = 0,
  configDelta = null,
}: {
  tasks: CompareTasks;
  leftChecks: { passed: number; total: number };
  rightChecks: { passed: number; total: number };
  costA: number;
  costB: number;
  onlyInOne?: number;
  configDelta?: string | null;
}) {
  const { same, fixed, broke, compared } = verdictCounts(tasks);
  const showCost = costA > 0 && costB > 0;
  return (
    <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
      {configDelta ? (
        <span className="font-mono text-foreground">{configDelta}</span>
      ) : null}
      {fixed === 0 && broke === 0 ? (
        <span>
          all <span className="font-mono tabular-nums text-foreground">{compared}</span> verdicts unchanged
        </span>
      ) : (
        <span>
          Run B fixes <span className="font-mono tabular-nums text-success">{fixed}</span>
          {broke > 0 ? (
            <>
              ,{" "}
              <span className="font-mono tabular-nums text-destructive">{broke}</span>{" "}
              <span className="text-destructive">regress</span>
            </>
          ) : (
            ", nothing regresses"
          )}
          <span className="text-muted-foreground"> · {same} unchanged</span>
        </span>
      )}
      {leftChecks.total > 0 && rightChecks.total > 0 ? (
        <CheckDelta left={leftChecks} right={rightChecks} />
      ) : null}
      {showCost ? (
        <span className="font-mono tabular-nums text-muted-foreground">
          · cost {formatCostMicro(costA)} → {formatCostMicro(costB)}
        </span>
      ) : null}
      {onlyInOne > 0 ? (
        <span className="text-muted-foreground/60">
          · {onlyInOne} task{onlyInOne > 1 ? "s" : ""} only in one run
        </span>
      ) : null}
    </div>
  );
}

/** Everything a metric row needs from one side of the comparison. */
function batchStats(batch: AgentTaskBatchRunDetail) {
  const checkTotal = Math.max(batch.total_checks, 1);
  return {
    passRate: batch.total_checks > 0 ? Math.round((batch.passed_checks / checkTotal) * 100) : null,
    checks: batch.total_checks > 0 ? `${batch.passed_checks}/${batch.total_checks}` : "—",
    tasks: `${batch.passed_tasks}/${batch.total_tasks}`,
    duration: runDurationMs(batch.started_at, batch.completed_at),
    cost: batch.total_cost != null && batch.total_cost > 0 ? batch.total_cost : null,
    tokens: batch.total_tokens != null && batch.total_tokens > 0 ? batch.total_tokens : null,
    // Issue #309: null means unknown (nobody reported), rendered as absent —
    // never as zero.
    reasoning: batch.total_reasoning_tokens ?? null,
    modelTime: batch.total_model_time_ms ?? null,
  };
}

function sideDot(batch: AgentTaskBatchRunDetail) {
  return conclusionStyle({
    status: batch.status,
    passed: batch.passed_tasks,
    failed: batch.failed_tasks,
    errored: batch.errored_tasks,
    total: batch.total_tasks,
  }).dot;
}

/** Run identity that leads with the model when the reported runs agree —
 *  "Partial · 10/12 reported" hides the one fact you identify a run by. */
function runIdentity(batch: AgentTaskBatchRunDetail): string {
  const c = batch.configuration;
  if (c.state === "partial" && c.configurations.length === 1) {
    const pair = c.configurations[0];
    if (pair) {
      return `${shortModel(pair.model)} · ${c.reported_task_runs}/${c.total_task_runs} runs`;
    }
  }
  return formatBatchExecution(c);
}

/** Hover-only detail for a run: its per-side facts live on the Summary tab —
 *  the working view's pickers stay name-only. */
function runStatTooltip(batch: AgentTaskBatchRunDetail): string {
  const s = batchStats(batch);
  return [
    s.passRate != null ? `${s.passRate}%` : null,
    s.checks !== "—" ? `${s.checks} checks` : null,
    `${s.tasks} tasks passed`,
    s.duration != null ? formatDuration(s.duration) : null,
    s.cost != null ? formatCostMicro(s.cost) : null,
    s.tokens != null ? `${tokenFormat(s.tokens)} tokens` : null,
    runIdentity(batch),
    formatRelativeTime(batch.created_at),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** PROTOTYPE — Tasks-tab pickers: identity + swap only (GitHub's compare
 *  selectors `base ⌄ … compare ⌄` carry names, never metrics). One line per
 *  run; all numbers live on the Summary tab or on hover. */
function MinimalPickers({
  batchA,
  batchB,
  projectId,
}: {
  batchA: AgentTaskBatchRunDetail;
  batchB: AgentTaskBatchRunDetail;
  projectId: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {[batchA, batchB].map((batch, i) => {
        const label = i === 0 ? "Run A" : "Run B";
        return (
          <div key={label} className="flex min-w-0 items-center gap-2" title={runStatTooltip(batch)}>
            {i === 1 && <span className="font-mono text-[11px] text-muted-foreground/50">vs</span>}
            <span className={cn("h-2 w-2 shrink-0 rounded-full", sideDot(batch))} aria-hidden />
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
            <span className="truncate text-[13px] font-medium text-foreground">
              {batchLabel(batch)}{" "}
              <span className="font-mono text-[11px] font-normal text-muted-foreground/60">
                #{batch.id.slice(0, 8)}
              </span>
            </span>
            <Link
              href={`/project/${projectId}/runs`}
              className="shrink-0 text-[11px] text-muted-foreground/70 hover:text-foreground"
            >
              Change
            </Link>
          </div>
        );
      })}
    </div>
  );
}

/** Summary tab — the aggregate on its own surface, ordered answer-first:
 *  who ran (identity, model-led) → the plain-numbers verdict → the per-task
 *  dumbbell chart (which run wins each task, visually) → exact numbers last. */
function SummaryView({
  batchA,
  batchB,
  projectId,
  tasks,
  leftChecks,
  rightChecks,
  leftRuns,
  rightRuns,
}: {
  batchA: AgentTaskBatchRunDetail;
  batchB: AgentTaskBatchRunDetail;
  projectId: string;
  tasks: CompareTasks;
  leftChecks: { passed: number; total: number };
  rightChecks: { passed: number; total: number };
  leftRuns: AgentTaskRunSummary[];
  rightRuns: AgentTaskRunSummary[];
}) {
  const a = batchStats(batchA);
  const b = batchStats(batchB);
  const checksDelta = rightChecks.passed - leftChecks.passed;
  const tasksDelta = batchB.passed_tasks - batchA.passed_tasks;
  const ratio = (x: number | null, y: number | null): string | null =>
    x && y && x > 0 ? `×${(y / x).toFixed(1)}` : null;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {[batchA, batchB].map((batch, i) => {
          const label = i === 0 ? "Run A" : "Run B";
          return (
            <div key={label} className="flex min-w-0 items-center gap-2" title={runStatTooltip(batch)}>
              {i === 1 && <span className="font-mono text-[11px] text-muted-foreground/50">vs</span>}
              <span className={cn("h-2 w-2 shrink-0 rounded-full", sideDot(batch))} aria-hidden />
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
              <span className="truncate text-[13px] font-medium text-foreground">
                {batchLabel(batch)}{" "}
                <span className="font-mono text-[11px] font-normal text-muted-foreground/60">
                  #{batch.id.slice(0, 8)}
                </span>
              </span>
              <span className="hidden truncate font-mono text-[11px] text-muted-foreground/70 sm:inline">
                {runIdentity(batch)} · {formatRelativeTime(batch.created_at)}
              </span>
              <Link
                href={`/project/${projectId}/runs`}
                className="shrink-0 text-[11px] text-muted-foreground/70 hover:text-foreground"
              >
                Change
              </Link>
            </div>
          );
        })}
      </div>

      <VerdictSentence
        tasks={tasks}
        leftChecks={leftChecks}
        rightChecks={rightChecks}
        costA={a.cost ?? 0}
        costB={b.cost ?? 0}
        configDelta={configurationDelta(batchA, batchB)}
      />

      <div className="mt-3">
        <TaskColumns leftRuns={leftRuns} rightRuns={rightRuns} projectId={projectId} />
      </div>

      <div className="mt-3 overflow-x-auto rounded-md border border-border bg-card">
        <div className="min-w-[420px]">
          <div className="grid grid-cols-[92px_minmax(0,1fr)_minmax(0,1fr)_64px] gap-x-3 border-b border-border px-4 py-2">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground/60">totals</div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Run A</div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Run B</div>
            <div className="text-right text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">Δ</div>
          </div>
          {(
            [
              {
                label: "checks",
                a: a.checks,
                b: b.checks,
                delta: checksDelta === 0 ? null : (
                  <span className={checksDelta > 0 ? "text-success" : "text-destructive"}>
                    {checksDelta > 0 ? "+" : ""}
                    {checksDelta}
                  </span>
                ),
              },
              {
                label: "tasks",
                a: a.tasks,
                b: b.tasks,
                delta: tasksDelta === 0 ? null : (
                  <span className={tasksDelta > 0 ? "text-success" : "text-destructive"}>
                    {tasksDelta > 0 ? "+" : ""}
                    {tasksDelta}
                  </span>
                ),
              },
              {
                label: "duration",
                a: a.duration != null ? formatDuration(a.duration) : "—",
                b: b.duration != null ? formatDuration(b.duration) : "—",
                delta: ratio(a.duration, b.duration) ?? null,
              },
              {
                label: "cost",
                a: a.cost != null ? formatCostMicro(a.cost) : "—",
                b: b.cost != null ? formatCostMicro(b.cost) : "—",
                delta: ratio(a.cost, b.cost) ?? null,
              },
              {
                label: "tokens",
                a: a.tokens != null ? tokenFormat(a.tokens) : "—",
                b: b.tokens != null ? tokenFormat(b.tokens) : "—",
                delta: ratio(a.tokens, b.tokens) ?? null,
              },
            ] as const
          ).map((row) => (
            <div
              key={row.label}
              className="grid grid-cols-[92px_minmax(0,1fr)_minmax(0,1fr)_64px] items-baseline gap-x-3 border-b border-border/60 px-4 py-1.5 last:border-b-0"
            >
              <div className="sticky left-0 bg-card text-[11px] uppercase tracking-wider text-muted-foreground/70">{row.label}</div>
              <div className="whitespace-nowrap font-mono text-[13px] tabular-nums text-foreground">{row.a}</div>
              <div className="whitespace-nowrap font-mono text-[13px] tabular-nums text-foreground">{row.b}</div>
              <div className="whitespace-nowrap text-right font-mono text-[12px] tabular-nums text-muted-foreground">
                {row.delta}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

