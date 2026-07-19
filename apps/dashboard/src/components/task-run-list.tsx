"use client";

import { useRouter } from "next/navigation";
import { ArrowUpRight, Clock, DollarSign } from "lucide-react";
import { type AgentTaskRunSummary } from "@/lib/agent-task-api";
import { TraceHomeLink } from "@/components/trace-detail";
import { TriggerBadge } from "@/components/trigger-badge";
import { cn } from "@/lib/utils";
import {
  TASK_RUN_STATUS,
  type TaskRunStatus,
  formatTaskRunDuration,
  formatTaskRunRelativeTime,
} from "./task-run-list.utils";

function TaskRunPassBar({ value, muted }: { value: number; muted?: boolean }) {
  if (muted) return <span className="font-mono text-[12px] text-muted-foreground">&mdash;</span>;
  const color = value >= 80 ? "bg-success" : value < 50 ? "bg-destructive" : "bg-foreground/30";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-12 overflow-hidden rounded-full bg-border">
        <div className={cn("h-full", color)} style={{ width: `${value}%` }} />
      </div>
      <span className="w-8 text-right font-mono text-[12px] tabular-nums text-muted-foreground">{value}%</span>
    </div>
  );
}

export function TaskRunRow({ run, projectId }: { run: AgentTaskRunSummary; projectId: string }) {
  const router = useRouter();
  const status = (run.status in TASK_RUN_STATUS ? run.status : "pending") as TaskRunStatus;
  const statusConfig = TASK_RUN_STATUS[status];
  const isDone = status === "passed" || status === "failed";
  const isRunning = status === "running";
  const isInactive = status === "pending" || status === "error";
  const passRate = run.total_checks > 0 ? Math.round((run.passed_checks / run.total_checks) * 100) : 0;
  const href = `/project/${projectId}/runs/task/${run.id}`;

  return (
    <div
      role="link"
      tabIndex={0}
      className="group block w-full px-6 py-3 text-left transition-colors hover:bg-card/60"
      onClick={(event) => {
        if (shouldIgnoreTaskRunNavigation(event.target)) return;
        router.push(href);
      }}
      onKeyDown={(event) => {
        if (shouldIgnoreTaskRunNavigation(event.target)) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          router.push(href);
        }
      }}
    >
      <div className="grid grid-cols-1 items-center gap-3 md:grid-cols-[1fr_auto_auto_auto_auto] md:gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", statusConfig.dot)} aria-hidden />
            <span className="truncate text-[14px] font-medium text-foreground">{run.task_id}</span>
            <span className={cn("shrink-0 text-[11px] font-medium uppercase tracking-wide", statusConfig.text)}>
              {statusConfig.label}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
            <span className="font-mono text-muted-foreground">{run.id.slice(0, 10)}</span>
            <span className="text-muted-foreground">&middot;</span>
            <span className="font-mono text-muted-foreground">{run.task_path.split("/").slice(-2).join("/")}</span>
            {isRunning && run.trace_run_id && (
              <>
                <span className="text-muted-foreground">&middot;</span>
                <TraceHomeLink
                  traceId={run.trace_run_id}
                  label="Trace home"
                  appearance="inline"
                  onClick={(e) => e.stopPropagation()}
                />
              </>
            )}
            {run.error_message && (
              <>
                <span className="text-muted-foreground">&middot;</span>
                <span className="block max-w-[200px] truncate whitespace-nowrap text-ellipsis text-destructive">
                  {run.error_message.slice(0, 80)}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex w-36 items-center gap-2">
          <TriggerBadge trigger={run.trigger} />
          <span className="truncate font-mono text-[12px] text-muted-foreground">{run.batch_run_id.slice(0, 8)}</span>
        </div>

        <div className="w-32 text-right">
          <div className="flex items-center justify-end gap-2 text-[12px]">
            {isRunning ? (
              <span className="font-mono tabular-nums text-muted-foreground">
                {run.passed_checks}/{run.total_checks}
              </span>
            ) : isInactive || run.total_checks === 0 ? (
              <span className="font-mono text-muted-foreground">&mdash;</span>
            ) : (
              <>
                <span className="font-mono tabular-nums text-success">{run.passed_checks}</span>
                <span className="text-muted-foreground">/</span>
                <span className="font-mono tabular-nums text-destructive">{run.failed_checks}</span>
                <span className="text-muted-foreground">/</span>
                <span className="font-mono tabular-nums text-muted-foreground">{run.total_checks}</span>
              </>
            )}
          </div>
          <div className="mt-1 flex justify-end">
            <div className="w-24">
              <TaskRunPassBar value={passRate} muted={!isDone} />
            </div>
          </div>
        </div>

        <div className="w-28 text-right">
          <div className="inline-flex items-center justify-end gap-1.5 font-mono text-[13px] tabular-nums text-foreground">
            <Clock className="h-3 w-3 text-muted-foreground" />
            {formatTaskRunDuration(run.started_at, run.completed_at)}
          </div>
          <div className="mt-1 inline-flex items-center justify-end gap-1 font-mono text-[12px] text-muted-foreground">
            <DollarSign className="h-3 w-3 text-muted-foreground" />
            {run.total_cost != null && run.total_cost > 0 ? run.total_cost.toFixed(4) : "\u2014"}
          </div>
        </div>

        <div className="flex w-36 items-center justify-end gap-2">
          <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
            {formatTaskRunRelativeTime(run.started_at)}
          </span>
          <span className="opacity-0 transition-opacity group-hover:opacity-100">
            <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
        </div>
      </div>
    </div>
  );
}

export function TaskRunListHeader() {
  return (
    <div className="sticky top-0 z-10 hidden border-b border-border bg-background/95 px-6 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground backdrop-blur md:block">
      <div className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-6">
        <span>Task run</span>
        <span className="w-36">Trigger · Batch</span>
        <span className="w-32 text-right">Judges</span>
        <span className="w-28 text-right">Duration · Cost</span>
        <span className="w-36 text-right">Started</span>
      </div>
    </div>
  );
}

function shouldIgnoreTaskRunNavigation(target: EventTarget | null) {
  return target instanceof HTMLElement
    && target.closest("a, button, input, select, textarea, [role='button'], [role='link']") !== null;
}
