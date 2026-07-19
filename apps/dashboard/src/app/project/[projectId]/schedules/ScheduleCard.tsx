"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Pause,
  Play,
  Trash2,
  Zap,
  ArrowUpRight,
} from "lucide-react";
import { type AgentTaskScheduleSummary } from "@/lib/agent-task-api";
import { useProjectId } from "@/lib/project-router";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  formatCadence,
  formatRelativeFuture,
  formatRelativePast,
  summarizeTasks,
  getScheduleOutcome,
  outcomeLabel,
  outcomeColor,
  outcomeDot,
  formatBatchCounts,
  formatFailureSummary,
  formatConsecutiveFailures,
  formatDate,
} from "./schedule-utils";

interface ScheduleCardProps {
  schedule: AgentTaskScheduleSummary;
  clientNow: number | null;
  onToggle: (schedule: AgentTaskScheduleSummary) => void;
  onDelete: (id: string) => void;
  onTrigger: (schedule: AgentTaskScheduleSummary) => void;
}

export default function ScheduleCard({
  schedule,
  clientNow,
  onToggle,
  onDelete,
  onTrigger,
}: ScheduleCardProps) {
  const projectId = useProjectId();
  const [expanded, setExpanded] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const outcome = getScheduleOutcome(schedule);
  const batch = schedule.last_batch;
  const readOnly = useProjectId() === "demo";

  return (
    <div className={`rounded-lg border transition-all ${
      schedule.enabled ? "border-border/60" : "border-border/40 opacity-60"
    } bg-card/75`}>
      {/* Layer 1: Rule */}
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-0.5 shrink-0 text-muted-foreground"
              aria-label={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            <div className="min-w-0">
              <Link href={`/project/${projectId}/schedules/${schedule.id}`} className="block">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium hover:text-primary">{schedule.name}</span>
                  {!schedule.enabled && (
                    <Badge variant="outline" className="text-[9px] uppercase tracking-wider">
                      Paused
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                  <Clock size={11} className="shrink-0" />
                  <span>{formatCadence(schedule)}</span>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="truncate">{summarizeTasks(schedule)}</span>
                </div>
              </Link>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-7 w-7 hover:text-emerald-500 hover:border-emerald-500/30"
              disabled={triggering || readOnly}
              onClick={async () => {
                setTriggering(true);
                await onTrigger(schedule);
                setTriggering(false);
              }}
              title={readOnly ? "Demo workspace is read-only" : "Run now"}
            >
              <Zap size={13} />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-7 w-7"
              disabled={readOnly}
              onClick={() => onToggle(schedule)}
              title={readOnly ? "Demo workspace is read-only" : (schedule.enabled ? "Pause" : "Resume")}
            >
              {schedule.enabled ? <Pause size={13} /> : <Play size={13} />}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-7 w-7 hover:text-destructive hover:border-destructive/30"
              disabled={readOnly}
              onClick={() => onDelete(schedule.id)}
              title={readOnly ? "Demo workspace is read-only" : "Delete"}
            >
              <Trash2 size={13} />
            </Button>
          </div>
        </div>
      </div>

      {/* Layer 2: Latest outcome */}
      <div className="border-t border-border/40 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="flex shrink-0 items-center gap-1.5">
            <span className={cn("h-1.5 w-1.5 rounded-full", outcomeDot(outcome))} />
            <span className={cn("font-medium", outcomeColor(outcome))}>
              {outcomeLabel(outcome)}
            </span>
          </span>

          {batch && (
            <>
              {batch.total_tasks > 0 && (
                <div className="flex h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-border">
                  {batch.passed_tasks > 0 && (
                    <div
                      className="h-full bg-success"
                      style={{ width: `${(batch.passed_tasks / batch.total_tasks) * 100}%` }}
                    />
                  )}
                  {batch.failed_tasks > 0 && (
                    <div
                      className="h-full bg-destructive"
                      style={{ width: `${(batch.failed_tasks / batch.total_tasks) * 100}%` }}
                    />
                  )}
                  {batch.errored_tasks > 0 && (
                    <div
                      className="h-full bg-warning"
                      style={{ width: `${(batch.errored_tasks / batch.total_tasks) * 100}%` }}
                    />
                  )}
                </div>
              )}
              <span className="font-mono tabular-nums text-muted-foreground">
                {formatBatchCounts(batch)}
              </span>
            </>
          )}

          {schedule.last_triggered_at && (
            <span className="text-muted-foreground">
              {formatRelativePast(schedule.last_triggered_at, clientNow)}
            </span>
          )}

          {schedule.enabled && schedule.next_run_at && (
            <span className="text-muted-foreground">
              Next: {formatRelativeFuture(schedule.next_run_at, clientNow)}
            </span>
          )}

          <div className="flex-1" />

          {schedule.last_batch_run_id && (
            <Link
              href={`/project/${projectId}/runs/${schedule.last_batch_run_id}`}
              className="flex shrink-0 items-center gap-0.5 text-primary hover:underline"
            >
              Open batch
              <ArrowUpRight size={11} />
            </Link>
          )}
        </div>

        {batch && batch.failure_breakdown.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-3 text-[11px] text-muted-foreground">
            <span className="text-muted-foreground/80">
              {formatFailureSummary(batch.failure_breakdown)}
            </span>
            {(() => {
              const consecutive = formatConsecutiveFailures(schedule.consecutive_failures);
              if (!consecutive) return null;
              return (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="font-medium text-destructive">{consecutive}</span>
                </>
              );
            })()}
          </div>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-border/40 px-4 py-3">
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <span className="text-muted-foreground">Timezone:</span>{" "}
              <span className="font-mono">{schedule.timezone}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Created:</span>{" "}
              <span className="font-mono">{formatDate(schedule.created_at)}</span>
            </div>
            {schedule.cadence_type === "adaptive" && (
              <div>
                <span className="text-muted-foreground">Adaptive range:</span>{" "}
                <span className="font-mono">
                  {schedule.min_interval_days}–{schedule.max_interval_days} days
                </span>
              </div>
            )}
            {schedule.last_triggered_at && (
              <div>
                <span className="text-muted-foreground">Last triggered:</span>{" "}
                <span className="font-mono">{formatDate(schedule.last_triggered_at)}</span>
              </div>
            )}
            {schedule.next_run_at && schedule.enabled && (
              <div>
                <span className="text-muted-foreground">Next run:</span>{" "}
                <span className="font-mono">{formatDate(schedule.next_run_at)}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
