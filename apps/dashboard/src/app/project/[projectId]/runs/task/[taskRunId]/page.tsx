import { getAgentTaskRun } from "@/lib/agent-task-api";
import { getTraceDetail } from "@/lib/traces-api";
import {
  deriveConversationFromTrace,
  type ChatMessage,
} from "@/lib/conversation-from-trace";
import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { TraceHomeLink } from "@/components/trace-detail";
import { Suspense } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronRight,
  Clock,
  DollarSign,
  Layers3,
  ListChecks,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { taskDetailHref } from "@/lib/task-routes";
import { TriggerInline } from "@/components/trigger-badge";
import { TaskRunDetailBody } from "./task-run-detail-body";
import { TaskRunAutoRefresh } from "@/components/agent-task-execution/task-run-auto-refresh";
import { OutcomeSummary } from "@/components/run-outcome";
import { formatTokenTotal, formatCostMicro } from "@/lib/format";

export const dynamic = "force-dynamic";

// Tab title: "Task Run #<short id>". Falls back to "Task Run" on fetch failure.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string; taskRunId: string }>;
}): Promise<Metadata> {
  const { taskRunId } = await params;
  try {
    const run = await getAgentTaskRun(taskRunId);
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

const STATUS_DOT: Record<string, { dot: string; text: string }> = {
  passed: { dot: "bg-success", text: "text-success" },
  failed: { dot: "bg-destructive", text: "text-destructive" },
  running: { dot: "bg-foreground animate-pulse", text: "text-muted-foreground" },
  error: { dot: "bg-warning", text: "text-warning" },
  pending: { dot: "bg-muted-foreground/40", text: "text-muted-foreground" },
};

export default async function TaskRunDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; taskRunId: string }>;
}) {
  const { projectId, taskRunId } = await params;

  let taskRun;
  let error: string | null = null;

  try {
    taskRun = await getAgentTaskRun(taskRunId);
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to fetch task run";
  }

  // Derive the conversation view from the linked trace when one exists. A fetch
  // failure here must not break the page — the empty conversation just renders
  // the empty state, and the trace link still points at the full viewer.
  const traceRunId = taskRun?.trace_run_id ?? null;
  let conversation: { messages: ChatMessage[] } = { messages: [] };
  if (taskRun && traceRunId) {
    try {
      const trace = await getTraceDetail(traceRunId, projectId);
      conversation = deriveConversationFromTrace(trace);
    } catch {
      // Leave conversation empty; the transcript tab shows its empty state.
    }
  }

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

  const checks = taskRun.checks_json ?? [];
  const checksPassed = checks.filter((c) => c.pass === true).length;
  const statusConf = STATUS_DOT[taskRun.status] ?? STATUS_DOT.pending;
  const statusLabel = taskRun.status.charAt(0).toUpperCase() + taskRun.status.slice(1);

  const isRunning = ["running", "pending", "queued"].includes(taskRun.status);

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
              <Link href={`/project/${projectId}/runs`} className="inline-flex items-center gap-1 hover:text-foreground">
                <ArrowLeft className="h-3 w-3" />
                Runs
              </Link>
              <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
              <Link href={`/project/${projectId}/runs/${taskRun.batch_run_id}`} className="font-mono hover:text-foreground">
                {taskRun.batch_run_id.slice(0, 8)}
              </Link>
              <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
              <Link href={taskDetailHref(projectId, taskRun.task_id)} className="hover:text-foreground">
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
              <Link href={taskDetailHref(projectId, taskRun.task_id)} className="inline-flex items-center gap-1.5">
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
            metadata={[
              {
                icon: Clock,
                value: formatDuration(taskRun.started_at, taskRun.completed_at),
                label: "duration",
              },
              {
                icon: DollarSign,
                value: formatCostMicro(taskRun.total_cost),
                label: taskRun.total_tokens != null
                  ? formatTokenTotal(taskRun.total_tokens)
                  : "cost",
              },
              ...(taskRun.adapter_name
                ? [{ value: taskRun.adapter_name, label: "adapter" }]
                : []),
            ]}
          />
        </div>

        {/* Error banner */}
        {taskRun.error_message && (
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
            conversation={conversation.messages}
            deliverables={taskRun.deliverables_json ?? null}
            traceRunId={taskRun.trace_run_id ?? null}
            projectId={projectId}
            commitSha={taskRun.task_source_commit_sha ?? null}
            taskId={taskRun.task_id}
          />
        </Suspense>
      </div>
    </div>
  );
}
