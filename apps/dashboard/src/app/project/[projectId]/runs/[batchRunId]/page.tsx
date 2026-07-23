import { getAgentTaskBatchRun } from "@/lib/agent-task-api";
import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronRight,
  Clock,
  DollarSign,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCostMicro } from "@/lib/format";
import { TriggerInline } from "@/components/trigger-badge";
import { TaskRunListHeader, TaskRunRow } from "@/components/task-run-list";
import { BatchRunAutoRefresh } from "@/components/agent-task-execution/batch-run-auto-refresh";
import { OutcomeSummary, FailuresByType, conclusionStyle } from "@/components/run-outcome";

export const dynamic = "force-dynamic";

// Tab title: "Run #<short id>". Falls back to "Run" if the fetch fails so the
// title never breaks the page load. Next.js dedupes this fetch against the
// one in the default export, so there's no extra request.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string; batchRunId: string }>;
}): Promise<Metadata> {
  const { batchRunId } = await params;
  try {
    const run = await getAgentTaskBatchRun(batchRunId);
    return { title: `Run #${run.id.slice(0, 8)}` };
  } catch {
    return { title: "Run" };
  }
}

const utcDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(value: string | null) {
  if (!value) return "—";
  return utcDateTimeFormatter.format(new Date(value));
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

function formatSelectionSummary(selectionQuery: Record<string, unknown> | null, totalTasks: number) {
  if (!selectionQuery) return `${totalTasks} tasks`;
  const taskPaths = selectionQuery.task_paths;
  if (Array.isArray(taskPaths) && taskPaths.length > 0) {
    return `${taskPaths.length} selected task${taskPaths.length === 1 ? "" : "s"}`;
  }
  if (typeof selectionQuery.folder_path === "string") return selectionQuery.folder_path;
  if (typeof selectionQuery.grep === "string") return `grep:${selectionQuery.grep}`;
  return `${totalTasks} tasks`;
}

export default async function BatchRunDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; batchRunId: string }>;
}) {
  const { projectId, batchRunId } = await params;

  let batchRun;
  let error: string | null = null;

  try {
    batchRun = await getAgentTaskBatchRun(batchRunId);
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to fetch batch run";
  }

  if (error) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
          <p className="font-medium">Error</p>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!batchRun) return null;

  const statusConf = conclusionStyle({
    status: batchRun.status,
    passed: batchRun.passed_tasks,
    failed: batchRun.failed_tasks,
    errored: batchRun.errored_tasks,
    total: batchRun.total_tasks,
  });
  const selectionSummary = formatSelectionSummary(batchRun.selection_query, batchRun.total_tasks);

  const isRunning = ["running", "queued"].includes(batchRun.status);

  return (
    <div className="mx-auto max-w-6xl">
      {isRunning && (
        <BatchRunAutoRefresh
          project={projectId}
          batchRunId={batchRunId}
          isRunning={isRunning}
        />
      )}
      <div className="border-b border-border bg-background">
        <div className="flex flex-col gap-3 px-6 py-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Link href={`/project/${projectId}/runs`} className="inline-flex items-center gap-1 hover:text-foreground">
                <ArrowLeft className="h-3 w-3" />
                Runs
              </Link>
              <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
              <span className="font-mono text-foreground">{batchRun.id.slice(0, 10)}</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2.5">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide",
                  statusConf.text,
                )}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full", statusConf.dot)} />
                {statusConf.label}
              </span>
              <h1 className="text-[20px] font-semibold tracking-tight">Run</h1>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
              <span>{batchRun.selection_type}</span>
              <span className="text-muted-foreground/50">·</span>
              <span>{selectionSummary}</span>
              <span className="text-muted-foreground/50">·</span>
              <TriggerInline trigger={batchRun.trigger} />
              <span className="text-muted-foreground/50">·</span>
              <span>{formatDate(batchRun.created_at)}</span>
            </div>
          </div>
        </div>

        <div className="border-t border-border">
          <OutcomeSummary
            counts={{
              passed: batchRun.passed_tasks,
              failed: batchRun.failed_tasks,
              errored: batchRun.errored_tasks,
              total: batchRun.total_tasks,
            }}
            unit="tasks"
            running={isRunning}
            metadata={[
              {
                icon: Clock,
                value: formatDuration(batchRun.started_at, batchRun.completed_at),
                label: "duration",
              },
              {
                icon: DollarSign,
                value: formatCostMicro(batchRun.total_cost),
                label: "cost",
              },
            ]}
          />

          <FailuresByType
            breakdown={batchRun.failure_breakdown}
            totalTasks={batchRun.total_tasks}
          />
        </div>
      </div>

      <div className="border-t border-border bg-background">
        {batchRun.task_runs.length === 0 ? (
          <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
            No task runs were recorded for this batch run.
          </div>
        ) : (
          <>
            <TaskRunListHeader />
            <div className="divide-y divide-border">
              {batchRun.task_runs.map((taskRun) => (
                <TaskRunRow key={taskRun.id} run={taskRun} projectId={projectId} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
