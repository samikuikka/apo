import { getAgentTaskRun, listAgentTaskRunJudgments } from "@/lib/agent-task-api";
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
  PenLine,
  Timer,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { taskDetailHref } from "@/lib/task-routes";
import { hrefWithRunCohort, parseDrilldownCohort } from "@/lib/run-cohort";
import { TriggerInline } from "@/components/trigger-badge";
import { DeleteRunButton } from "@/components/runs/DeleteRunButton";
import { TaskRunDetailBody } from "./task-run-detail-body";
import { TaskRunAutoRefresh } from "@/components/agent-task-execution/task-run-auto-refresh";
import { OutcomeSummary } from "@/components/run-outcome";
import { formatInterval, formatTokenTotal, formatCostMicro } from "@/lib/format";
import { getProject } from "@/lib/projects-api";
import GenerationExecutionNotice from "@/components/generation-execution-notice";
import { RunJudgmentsSection } from "./run-judgments-section";

export const dynamic = "force-dynamic";

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

const utcDateTimeSecondsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function formatDate(value: string | null) {
  if (!value) return "—";
  return utcDateTimeSecondsFormatter.format(new Date(value));
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
  const statusConf = STATUS_DOT[taskRun.status] ?? UNKNOWN_STATUS_DOT;
  const statusLabel = taskRun.status.charAt(0).toUpperCase() + taskRun.status.slice(1);

  const isRunning = ["running", "pending", "queued"].includes(taskRun.status);
  const generationErrors = taskRun.generation_execution?.errored ?? 0;
  const verdictSuppressed =
    taskRun.status === "error" &&
    taskRun.pass_result === null &&
    generationErrors > 0;
  const costIsPartial = generationErrors > 0 || (taskRun.unpriced_call_count ?? 0) > 0;
  // Corrections apply to terminal verdict-bearing runs with
  // recorded checks. Running/error/no-verdict runs render read-only.
  // Corrections apply to terminal verdict-bearing runs with recorded
  // checks — and only for roles that may edit scores: viewers (and the
  // anonymous demo visitor) never see the affordance at all.
  const correctable =
    (taskRun.status === "passed" || taskRun.status === "failed") &&
    taskRun.pass_result !== null &&
    checks.length > 0 &&
    project?.permissions?.can_edit_scores === true;

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
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
              <span className="font-mono">{taskRun.task_path.split("/").slice(-2).join("/")}</span>
              {taskRun.adapter_name && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span>{taskRun.adapter_name}</span>
                </>
              )}
              {taskRun.run_configuration && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span className="text-muted-foreground">Model</span>
                  <span className="font-mono text-foreground">{taskRun.run_configuration.model}</span>
                  <span className="text-muted-foreground">Effort</span>
                  <span className="font-mono text-foreground">
                    {taskRun.run_configuration.effort ?? "—"}
                  </span>
                  <span className="text-muted-foreground/50">(reported by adapter)</span>
                </>
              )}
              {taskRun.primary_model &&
                (!taskRun.run_configuration ||
                  taskRun.run_configuration.model !== taskRun.primary_model) && (
                  <>
                    <span className="text-muted-foreground/50">·</span>
                    <span className="text-muted-foreground">Observed</span>
                    <span className="font-mono text-foreground">{taskRun.primary_model}</span>
                  </>
                )}
              {taskRun.trigger?.source && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <TriggerInline trigger={taskRun.trigger} />
                </>
              )}
              <>
                <span className="text-muted-foreground/50">·</span>
                <Link href={`/project/${projectId}/runs/${taskRun.batch_run_id}`} className="font-mono hover:text-foreground">
                  batch {taskRun.batch_run_id.slice(0, 8)}
                </Link>
              </>
              <span className="text-muted-foreground/50">·</span>
              <span>{formatDate(taskRun.started_at)}</span>
            </div>
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
              failed: Math.max(checks.length - checksPassed, 0),
              errored: 0,
              total: checks.length,
            }}
            unit="checks"
            running={isRunning}
            verdictUnavailable={verdictSuppressed}
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
                  ? `${formatTokenTotal(taskRun.total_tokens)}${generationErrors > 0 ? " partial" : ""}`
                  : "cost",
              },
              // Reasoning rollup (issue #309): unknown renders as unknown —
              // a provider that never sent the reasoning dimension must not
              // read as "the model didn't think". Linked to the deepest call.
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
                  ? [{ icon: Brain, key: "reasoning", value: "not reported", label: "reasoning" }]
                  : []),
              ...(taskRun.max_call_latency_ms != null
                ? [{
                    icon: Timer,
                    key: "slowest-call",
                    value: observationValue(
                      projectId,
                      taskRun.trace_run_id,
                      taskRun.max_call_latency_call_id,
                      formatInterval(taskRun.max_call_latency_ms),
                      "The slowest single model call",
                    ),
                    label: "slowest call",
                  }]
                : []),
              ...(taskRun.total_model_time_ms != null
                ? [{
                    icon: Gauge,
                    key: "model-time",
                    value: formatInterval(taskRun.total_model_time_ms),
                    label: "model time",
                  }]
                : []),
              ...(taskRun.adapter_name
                ? [{ value: taskRun.adapter_name, label: "adapter" }]
                : []),
              ...((taskRun.corrected_tests ?? 0) > 0
                ? [{ icon: PenLine, value: `${taskRun.corrected_tests} corrected`, label: "tests" }]
                : []),
            ]}
          />
        </div>

        {judgments && judgments.judgments.length > 0 && (
          <RunJudgmentsSection taskRunId={taskRun.id} judgments={judgments.judgments} />
        )}

        <GenerationExecutionNotice
          execution={taskRun.generation_execution ?? null}
          verdictSuppressed={verdictSuppressed}
        />

        {/* Error banner */}
        {taskRun.error_message && generationErrors === 0 && (
          <div className="mx-6 mt-4 border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
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
          />
        </Suspense>
      </div>
    </div>
  );
}
