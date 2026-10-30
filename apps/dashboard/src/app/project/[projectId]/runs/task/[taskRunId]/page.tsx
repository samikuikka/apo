import { getAgentTaskRun, listAgentTaskRunJudgments } from "@/lib/agent-task-api";
import type { AgentTaskRunDetail } from "@/lib/agent-task-api";
import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { TraceHomeLink } from "@/components/trace-detail";
import { Suspense, cache } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Brain,
  ChevronRight,
  Clock,
  DollarSign,
  Gauge,
  Layers3,
  ListChecks,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { taskDetailHref } from "@/lib/task-routes";
import { hrefWithRunCohort, parseDrilldownCohort } from "@/lib/run-cohort";
import {
  acceptsCorrections,
  errorMessageTone,
  generationNoticeProps,
  isJudgeNoVerdictRun,
  isVerdictSuppressedByGenerations,
  runStatusLabel,
  showsErrorBanner,
} from "@/lib/run-verdict";
import { DeleteRunButton } from "@/components/runs/DeleteRunButton";
import { TaskRunDetailBody } from "./task-run-detail-body";
import { RunHeaderMetadata, type RunHeaderFacts } from "./run-header-details";
import { TaskRunAutoRefresh } from "@/components/agent-task-execution/task-run-auto-refresh";
import { OutcomeSummary } from "@/components/run-outcome";
import { formatTokenTotal, formatCostMicro } from "@/lib/format";
import { getProject } from "@/lib/projects-api";
import GenerationExecutionNotice from "@/components/generation-execution-notice";
import { RunJudgmentsSection } from "./run-judgments-section";
import { RunNotices } from "./run-notices";
import { toCorrectedCheckNotices } from "./run-notices-model";

export const dynamic = "force-dynamic";

const ERROR_BANNER_TONE = {
  note: "border-border bg-muted text-muted-foreground",
  warning: "border-warning/30 bg-warning/10 text-warning",
  error: "border-destructive/30 bg-destructive/10 text-destructive",
} as const;

// Per-request memo so generateMetadata and the page body share one fetch.
const getAgentTaskRunCached = cache(getAgentTaskRun);

// Tab title: "Task Run #<short id>". Falls back to "Task Run" on fetch failure.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string; taskRunId: string }>;
}): Promise<Metadata> {
  const { taskRunId } = await params;
  try {
    const run = await getAgentTaskRunCached(taskRunId);
    return { title: `Task Run #${run.task_id.slice(0, 8)}` };
  } catch {
    return { title: "Task Run" };
  }
}

function formatDuration(start: string | null, end: string | null) {
  if (!start || !end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

/** Facts for the run header's quiet line + Details card, pre-resolved so
 * the client component stays a dumb renderer. */
function runHeaderFacts(run: AgentTaskRunDetail, projectId: string): RunHeaderFacts {
  // The provider rollup is keyed on (model, provider, route), so one host
  // label legitimately spans several pairs (task model and judge model on
  // the same host) — sum the calls per label (route wins over provider).
  const calls = new Map<string, number>();
  for (const pair of run.model_providers ?? []) {
    const label = pair.route || pair.provider;
    if (label) calls.set(label, (calls.get(label) ?? 0) + pair.calls);
  }
  const configured = run.run_configuration?.model ?? null;
  return {
    taskPathFull: run.task_path,
    taskPathTail: run.task_path.split("/").slice(-2).join("/"),
    adapterName: run.adapter_name,
    configuredModel: configured,
    effort: run.run_configuration?.effort ?? null,
    observedModel:
      run.primary_model && run.primary_model !== configured ? run.primary_model : null,
    hosts: [...calls].map(([label, count]) => ({ label, calls: count })),
    trigger: run.trigger,
    requestedBy: run.requested_by_label ?? null,
    batchRunId: run.batch_run_id,
    batchHref: `/project/${projectId}/runs/${run.batch_run_id}`,
    startedAt: run.started_at,
  };
}

/** tok/s with one decimal under 100 and integers above — the precision a
 * host comparison can actually read (issue #307). */
function formatTokPerS(value: number): string {
  return `${value < 100 ? value.toFixed(1) : Math.round(value)} tok/s`;
}

/** Chip value that deep-links into the trace observation behind a max
 * metric (issue #309) — "slowest call" / "max reasoning" jump straight to
 * the winning span. Plain text when the run has no trace to link into. */
function observationValue(
  projectId: string,
  traceRunId: string | null,
  callId: string | null | undefined,
  text: string,
  title: string | undefined,
) {
  if (!traceRunId || !callId) return text;
  return (
    <Link
      href={`/project/${projectId}/traces/${traceRunId}?observation=${callId}`}
      title={title}
      className="underline-offset-2 hover:underline"
    >
      {text}
    </Link>
  );
}

const STATUS_DOT: Record<string, { dot: string; text: string }> = {
  passed: { dot: "bg-success", text: "text-success" },
  failed: { dot: "bg-destructive", text: "text-destructive" },
  running: { dot: "bg-foreground animate-pulse", text: "text-muted-foreground" },
  error: { dot: "bg-warning", text: "text-warning" },
  pending: { dot: "bg-muted-foreground/40", text: "text-muted-foreground" },
};

// Unknown statuses get a neutral dot — the raw status string is the label.
// Never borrow pending's styling as a fallback: an unknown value is not
// "pending", and masking it hides backend drift.
const UNKNOWN_STATUS_DOT = { dot: "bg-muted-foreground/40", text: "text-muted-foreground" };

export default async function TaskRunDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; taskRunId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId, taskRunId }, query] = await Promise.all([params, searchParams]);
  // Scope loop: a cohort handed in by the Runs page keeps flowing —
  // the task back-links below forward it into the task detail page.
  const cohort = parseDrilldownCohort(query);

  // Start the project fetch in parallel — it's independent of the task run.
  // A failure here is non-fatal (sourceType falls back to null).
  const projectPromise = getProject(projectId).catch(() => null);

  let taskRun;
  let error: string | null = null;

  try {
    taskRun = await getAgentTaskRunCached(taskRunId);
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to fetch task run";
  }

  // The transcript is NOT derived here: it requires the full trace detail
  // (every call's input/output — megabytes for agent runs), and the default
  // tab is "checks". TaskRunDetailBody fetches and derives it client-side
  // when the transcript tab first opens.

  if (error) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
          <p className="font-medium">Error</p>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!taskRun) return null;

  // Project result — started in parallel with the task run above, and only
  // awaited here (after the guards) so the error path never waits on it.
  const project = await projectPromise;
  const sourceType = project?.task_source?.source_type ?? null;
  const canDeleteRuns =
    project?.current_user_role === "owner" ||
    project?.current_user_role === "admin";

  // Issue #159: judgments only exist once a run was re-judged. Non-fatal —
  // the section just stays hidden if the read fails.
  const judgments =
    (taskRun.judgments_count ?? 0) > 0
      ? await listAgentTaskRunJudgments(taskRunId).catch(() => null)
      : null;

  const checks = taskRun.checks_json ?? [];
  const checksPassed = checks.filter((c) => c.pass === true).length;
  // Judge-errored checks failed for lack of a verdict, not on evidence —
  // their own bucket, apart from genuine fails (issue #323).
  const checksErrored = checks.filter(
    (c) => c.pass !== true && c.outcome === "error",
  ).length;
  const statusConf = STATUS_DOT[taskRun.status] ?? UNKNOWN_STATUS_DOT;
  // Issue #323: only judge-errored checks left non-passing — the run has no
  // verdict, which is not the agent failing (nor an execution error).
  const judgeNoVerdict = isJudgeNoVerdictRun(taskRun);
  const statusLabel = runStatusLabel(
    taskRun,
    taskRun.status.charAt(0).toUpperCase() + taskRun.status.slice(1),
  );

  const isRunning = ["running", "pending", "queued"].includes(taskRun.status);
  const generationErrors = taskRun.generation_execution?.errored ?? 0;
  // #149 withholds the verdict only when errored generations dominate; a
  // recovered minority keeps the verdict (and the error banner below).
  const verdictSuppressed = isVerdictSuppressedByGenerations(taskRun);
  const costIsPartial = generationErrors > 0 || (taskRun.unpriced_call_count ?? 0) > 0;
  // Corrections apply to terminal verdict-bearing runs — and judge
  // no-verdict runs, where a human decision supplies the missing verdict —
  // with recorded checks, and only for roles that may edit scores: viewers
  // (and the anonymous demo visitor) never see the affordance at all.
  const correctable =
    acceptsCorrections(taskRun) &&
    checks.length > 0 &&
    project?.permissions?.can_edit_scores === true;

  // Run-level notices (issue #410): the strip below the outcome summary owns
  // the corrections rollup — check-level detail lives there, not in the
  // outcome summary's metadata.
  const correctedNotices = toCorrectedCheckNotices(checks);

  return (
    <div className="mx-auto max-w-6xl">
      {isRunning && (
        <TaskRunAutoRefresh
          project={projectId}
          taskRunId={taskRunId}
          isRunning={isRunning}
        />
      )}
      {/* Run header */}
      <div className="border-b border-border bg-background">
        <div className="flex flex-col gap-3 px-6 py-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Link href={hrefWithRunCohort(`/project/${projectId}/runs`, cohort)} className="inline-flex items-center gap-1 hover:text-foreground">
                <ArrowLeft className="h-3 w-3" />
                Runs
              </Link>
              <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
              <Link href={`/project/${projectId}/runs/${taskRun.batch_run_id}`} className="font-mono hover:text-foreground">
                {taskRun.batch_run_id.slice(0, 8)}
              </Link>
              <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
              <Link href={hrefWithRunCohort(taskDetailHref(projectId, taskRun.task_id), cohort)} className="hover:text-foreground">
                {taskRun.task_id}
              </Link>
              <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
              <span className="font-mono text-foreground">{taskRun.id.slice(0, 10)}</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2.5">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide",
                  statusConf.text,
                )}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full", statusConf.dot)} />
                {statusLabel}
              </span>
              <h1 className="text-[20px] font-semibold tracking-tight">{taskRun.task_id}</h1>
            </div>
            <RunHeaderMetadata facts={runHeaderFacts(taskRun, projectId)} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" asChild variant="outline" size="sm" className="h-8 border-border bg-card text-[13px] font-normal hover:bg-card/80">
              <Link href={hrefWithRunCohort(taskDetailHref(projectId, taskRun.task_id), cohort)} className="inline-flex items-center gap-1.5">
                <ListChecks className="h-3.5 w-3.5" /> Task
              </Link>
            </Button>
            <Button type="button" asChild variant="outline" size="sm" className="h-8 border-border bg-card text-[13px] font-normal hover:bg-card/80">
              <Link href={`/project/${projectId}/runs/${taskRun.batch_run_id}`} className="inline-flex items-center gap-1.5">
                <Layers3 className="h-3.5 w-3.5" /> Run
              </Link>
            </Button>
            {taskRun.trace_run_id && (
              <TraceHomeLink
                traceId={taskRun.trace_run_id}
                appearance="button"
                buttonVariant="default"
                buttonSize="sm"
                className="h-8 gap-1.5 text-[13px] font-medium"
              />
            )}
            {!isRunning && (
              <DeleteRunButton
                target={{ kind: "task-run", taskRunId: taskRun.id }}
                canDelete={canDeleteRuns}
                redirectTo={`/project/${projectId}/runs/${taskRun.batch_run_id}`}
                appearance="button"
              />
            )}
          </div>
        </div>

        {/* Outcome summary */}
        <div className="border-t border-border">
          <OutcomeSummary
            counts={{
              passed: checksPassed,
              failed: Math.max(checks.length - checksPassed - checksErrored, 0),
              errored: checksErrored,
              total: checks.length,
            }}
            unit="checks"
            running={isRunning}
            verdictUnavailable={verdictSuppressed || judgeNoVerdict}
            metadata={[
              {
                icon: Clock,
                value: formatDuration(taskRun.started_at, taskRun.completed_at),
                label: "duration",
              },
              {
                icon: DollarSign,
                value: `${formatCostMicro(taskRun.total_cost)}${costIsPartial ? " partial" : ""}`,
                label: taskRun.total_tokens != null
                  ? `${formatTokenTotal(taskRun.total_tokens, taskRun.generation_usage?.cache_read_tokens)}${generationErrors > 0 ? " partial" : ""}`
                  : "cost",
              },
              // Reasoning rollup (issue #309): unknown renders as an em dash —
              // a provider that never sent the reasoning dimension must not
              // read as "the model didn't think".
              ...(taskRun.total_reasoning_tokens != null
                ? [{
                    icon: Brain,
                    key: "reasoning",
                    value: observationValue(
                      projectId,
                      taskRun.trace_run_id,
                      taskRun.max_call_reasoning_call_id,
                      formatTokenTotal(taskRun.total_reasoning_tokens),
                      taskRun.max_call_reasoning_tokens != null
                        ? `max ${formatTokenTotal(taskRun.max_call_reasoning_tokens)} in a single call`
                        : undefined,
                    ),
                    label: "reasoning",
                  }]
                : (taskRun.total_tokens ?? 0) > 0
                  ? [{ icon: Brain, key: "reasoning", value: "—", label: "reasoning" }]
                  : []),
              // Median decode throughput (issue #307): the number host
              // comparisons are about — output tokens over the decode
              // window. Only shown when at least one call measured it.
              ...(taskRun.generation_usage?.median_output_tok_s != null
                ? [{
                    icon: Gauge,
                    key: "speed",
                    value: `${formatTokPerS(taskRun.generation_usage.median_output_tok_s)} med`,
                    label: "decode",
                  }]
                : []),
            ]}
          />
        </div>

        <RunNotices correctedChecks={correctedNotices} drift={taskRun.model_drift} />

        {judgments && judgments.judgments.length > 0 && (
          <RunJudgmentsSection taskRunId={taskRun.id} judgments={judgments.judgments} />
        )}

        <GenerationExecutionNotice {...generationNoticeProps(taskRun)} />

        {/* Error banner */}
        {showsErrorBanner(taskRun) && taskRun.error_message && (
          <div
            className={cn(
              "mx-6 mt-4 border px-4 py-3 text-[13px]",
              ERROR_BANNER_TONE[errorMessageTone(taskRun)],
            )}
          >
            {taskRun.error_message.slice(0, 200)}
          </div>
        )}

        {/* Trace persistence failure banner */}
        {taskRun.trace_persistence_status === "failed" && (
          <div className="mx-6 mt-4 border border-warning/30 bg-warning/10 px-4 py-3 text-[13px] text-warning">
            <span className="font-medium">Trace was not saved.</span>
            {taskRun.trace_error_message && (
              <span className="text-warning/80"> {taskRun.trace_error_message.slice(0, 200)}</span>
            )}
          </div>
        )}

        <Suspense>
          <TaskRunDetailBody
            checks={checks}
            deliverables={taskRun.deliverables_json ?? null}
            deliverableItems={taskRun.deliverables ?? []}
            traceRunId={taskRun.trace_run_id ?? null}
            projectId={projectId}
            commitSha={taskRun.task_source_commit_sha ?? null}
            taskId={taskRun.task_id}
            sourceType={sourceType}
            taskDefinition={taskRun.task_definition ?? null}
            taskRunId={taskRun.id}
            correctable={correctable}
            taskNotes={taskRun.task_notes ?? []}
          />
        </Suspense>
      </div>
    </div>
  );
}
