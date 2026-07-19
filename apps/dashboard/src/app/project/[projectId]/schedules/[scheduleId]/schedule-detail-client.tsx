"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  Clock,
  Pause,
  Play,
  Zap,
} from "lucide-react";
import type {
  AgentTaskScheduleDetail,
  AdaptiveTaskState,
  AgentTaskSummary,
} from "@/lib/agent-task-api";
import {
  triggerSchedule,
  updateAgentTaskSchedule,
} from "@/lib/agent-task-api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { taskDetailHref } from "@/lib/task-routes";
import {
  formatCadence,
  formatRelativePast,
  formatRelativeFuture,
  summarizeTasks,
  getScheduleOutcome,
  outcomeLabel,
  outcomeColor,
  outcomeDot,
  formatBatchCounts,
  formatFailureSummary,
  formatConsecutiveFailures,
} from "../schedule-utils";

interface ScheduleDetailClientProps {
  projectId: string;
  schedule: AgentTaskScheduleDetail;
  adaptiveStates: AdaptiveTaskState[];
  taskNames: Map<string, AgentTaskSummary>;
}

const STATUS_DOT: Record<string, string> = {
  passed: "bg-success",
  failed: "bg-destructive",
  error: "bg-warning",
};

function formatInterval(days: number): string {
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days === Math.floor(days)) return `${days}d`;
  return `${days.toFixed(1)}d`;
}

export function ScheduleDetailClient({
  projectId,
  schedule: initialSchedule,
  adaptiveStates,
  taskNames,
}: ScheduleDetailClientProps) {
  const router = useRouter();
  const [schedule, setSchedule] = useState(initialSchedule);
  const [clientNow, setClientNow] = useState<number | null>(null);
  const [triggering, setTriggering] = useState(false);

  useEffect(() => {
    setClientNow(Date.now());
    const id = setInterval(() => setClientNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const handleTrigger = useCallback(async () => {
    setTriggering(true);
    try {
      const result = await triggerSchedule(schedule.id);
      router.push(
        `/project/${projectId}/runs/${result.batch_run_id}`,
      );
    } finally {
      setTriggering(false);
    }
  }, [schedule.id, router, projectId]);

  const handleToggle = useCallback(async () => {
    const updated = await updateAgentTaskSchedule(schedule.id, {
      enabled: !schedule.enabled,
    });
    setSchedule(updated);
  }, [schedule.id, schedule.enabled]);

  const outcome = getScheduleOutcome(schedule);
  const isAdaptive = schedule.cadence_type === "adaptive";
  const readOnly = projectId === "demo";

  const nowMs = clientNow;

  return (
    <div className="mx-auto max-w-5xl">
      {/* Header */}
      <div className="border-b border-border bg-background">
        <div className="px-6 py-4">
          <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Link
              href={`/project/${projectId}/schedules`}
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <ArrowLeft className="h-3 w-3" />
              Schedules
            </Link>
            <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
            <span className="font-mono text-foreground">{schedule.id.slice(0, 12)}</span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2.5">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 border border-border bg-card px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide",
                outcomeColor(outcome),
              )}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", outcomeDot(outcome))} />
              {outcomeLabel(outcome)}
            </span>
            <h1 className="text-[18px] font-semibold tracking-tight">{schedule.name}</h1>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3 text-muted-foreground/50" />
              {formatCadence(schedule)}
            </span>
            <span className="text-muted-foreground/50">·</span>
            <span>{summarizeTasks(schedule)}</span>
            {isAdaptive && (
              <>
                <span className="text-muted-foreground/50">·</span>
                <span className="font-mono">
                  {schedule.min_interval_days}–{schedule.max_interval_days}d range
                </span>
              </>
            )}
            <span className="text-muted-foreground/50">·</span>
            <span className="font-mono">{schedule.timezone}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-6 py-2.5">
          <Button
            type="button"
            variant="default"
            size="sm"
            className="h-8 gap-1.5 text-[13px]"
            disabled={triggering || readOnly}
            onClick={handleTrigger}
          >
            <Zap className="h-3.5 w-3.5" />
            {triggering ? "Starting…" : "Run now"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-[13px]"
            disabled={readOnly}
            onClick={handleToggle}
          >
            {schedule.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {schedule.enabled ? "Pause" : "Resume"}
          </Button>
          {schedule.last_batch_run_id && (
            <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-[13px]" asChild>
              <Link href={`/project/${projectId}/runs/${schedule.last_batch_run_id}`}>
                Open batch
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="bg-background">
        {isAdaptive ? (
          <AdaptiveScheduleBody
            projectId={projectId}
            schedule={schedule}
            adaptiveStates={adaptiveStates}
            taskNames={taskNames}
            clientNow={nowMs}
          />
        ) : (
          <FixedScheduleBody schedule={schedule} clientNow={nowMs} />
        )}
      </div>
    </div>
  );
}

function AdaptiveScheduleBody({
  projectId,
  schedule,
  adaptiveStates,
  taskNames,
  clientNow,
}: {
  projectId: string;
  schedule: AgentTaskScheduleDetail;
  adaptiveStates: AdaptiveTaskState[];
  taskNames: Map<string, AgentTaskSummary>;
  clientNow: number | null;
}) {
  const now = clientNow ?? Date.now();

  const rows = adaptiveStates
    .map((state) => {
      const task = taskNames.get(state.task_id);
      const displayName = task?.display_name ?? state.task_id;
      const folder = task?.folder_path ?? "";
      const nextRunMs = state.next_run_at ? new Date(state.next_run_at).getTime() : null;
      const isDue = nextRunMs === null || nextRunMs <= now;
      return { state, displayName, folder, nextRunMs, isDue };
    })
    .sort((a, b) => {
      if (a.nextRunMs === null && b.nextRunMs === null) return 0;
      if (a.nextRunMs === null) return -1;
      if (b.nextRunMs === null) return 1;
      return a.nextRunMs - b.nextRunMs;
    });

  const dueCount = rows.filter((r) => r.isDue).length;
  const nextBatchMs = schedule.next_run_at ? new Date(schedule.next_run_at).getTime() : null;

  return (
    <div>
      {/* Next batch callout */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-6 py-3">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Next batch
        </span>
        <span className="font-mono text-[13px] tabular-nums text-foreground">
          {nextBatchMs ? formatRelativeFuture(schedule.next_run_at, clientNow) : "—"}
        </span>
        <span className="text-[12px] text-muted-foreground">
          <span className={cn("font-mono tabular-nums", dueCount > 0 ? "text-warning" : "text-foreground")}>
            {dueCount}
          </span>
          {" of "}
          {rows.length}
          {" tasks due"}
        </span>
      </div>

      {/* Per-task table */}
      {rows.length === 0 ? (
        <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
          No adaptive state yet. Tasks will appear here after the first batch run.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                <th className="px-6 py-2 font-medium">Task</th>
                <th className="px-3 py-2 text-right font-medium">Interval</th>
                <th className="px-3 py-2 text-right font-medium">Ease</th>
                <th className="px-3 py-2 text-right font-medium">Streak</th>
                <th className="px-3 py-2 font-medium">Last run</th>
                <th className="px-6 py-2 font-medium">Next run</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ state, displayName, folder, isDue }) => {
                const lastStatusDot = state.last_status
                  ? STATUS_DOT[state.last_status] ?? "bg-muted-foreground/30"
                  : "bg-muted-foreground/30";
                return (
                  <tr
                    key={state.task_id}
                    className="border-b border-border/40 transition-colors hover:bg-muted/20"
                  >
                    <td className="px-6 py-2.5">
                      <Link
                        href={taskDetailHref(projectId, state.task_id)}
                        className="block hover:text-primary"
                      >
                        <div className="text-[13px] font-medium text-foreground">{displayName}</div>
                        {folder && (
                          <div className="truncate text-[11px] text-muted-foreground/60">{folder}</div>
                        )}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-foreground/80">
                      {formatInterval(state.current_interval_days)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-muted-foreground">
                      {state.ease_factor.toFixed(1)}×
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <span
                        className={cn(
                          "font-mono text-[12px] tabular-nums",
                          state.consecutive_passes > 0
                            ? "text-success"
                            : "text-destructive",
                        )}
                      >
                        {state.consecutive_passes}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {state.last_run_at ? (
                        <Link
                          href={taskDetailHref(projectId, state.task_id)}
                          className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-primary"
                        >
                          <span className={cn("h-1.5 w-1.5 rounded-full", lastStatusDot)} />
                          {formatRelativePast(state.last_run_at, clientNow)}
                        </Link>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                          <span className={cn("h-1.5 w-1.5 rounded-full", lastStatusDot)} />
                          never
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-2.5">
                      {isDue ? (
                        <span className="font-medium text-[12px] text-warning">Due now</span>
                      ) : (
                        <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
                          {formatRelativeFuture(state.next_run_at, clientNow)}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FixedScheduleBody({
  schedule,
  clientNow,
}: {
  schedule: AgentTaskScheduleDetail;
  clientNow: number | null;
}) {
  const batch = schedule.last_batch;
  const outcome = getScheduleOutcome(schedule);

  return (
    <div className="px-6 py-4">
      <div className="border border-border bg-card p-4">
        <div className="flex items-center gap-3 text-[13px]">
          <span className={cn("h-2 w-2 rounded-full", outcomeDot(outcome))} />
          <span className={cn("font-medium", outcomeColor(outcome))}>
            {outcomeLabel(outcome)}
          </span>
          {batch && (
            <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
              {formatBatchCounts(batch)}
            </span>
          )}
        </div>

        {batch && batch.failure_breakdown.length > 0 && (
          <div className="mt-2 text-[12px] text-muted-foreground">
            {formatFailureSummary(batch.failure_breakdown)}
            {(() => {
              const c = formatConsecutiveFailures(schedule.consecutive_failures);
              return c ? <span className="ml-2 font-medium text-destructive">· {c}</span> : null;
            })()}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
          {schedule.last_triggered_at && (
            <span>
              Last run: {formatRelativePast(schedule.last_triggered_at, clientNow)}
            </span>
          )}
          {schedule.enabled && schedule.next_run_at && (
            <span>
              Next: {formatRelativeFuture(schedule.next_run_at, clientNow)}
            </span>
          )}
        </div>

        <p className="mt-3 text-[12px] text-muted-foreground/70">
          This schedule runs all selected tasks together on a fixed cadence.
        </p>
      </div>
    </div>
  );
}
