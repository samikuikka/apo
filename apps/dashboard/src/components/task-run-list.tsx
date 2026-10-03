"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Clock, DollarSign, GitCompare, Hash } from "lucide-react";
import { type AgentTaskRunSummary, providerLabels } from "@/lib/agent-task-api";
import { TraceHomeLink } from "@/components/trace-detail";
import { TriggerBadge } from "@/components/trigger-badge";
import { DeleteRunButton } from "@/components/runs/DeleteRunButton";
import { TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { errorMessageTextClass, runStatusLabel } from "@/lib/run-verdict";
import { formatCostMicro, formatTokenTotal } from "@/lib/format";
import { formatRunExecution, formatRunExecutionFull } from "@/lib/run-configuration";
import {
  formatTaskRunDuration,
  formatTaskRunRelativeTime,
  taskRunStatusConfig,
} from "./task-run-list.utils";

// Column widths shared by the header and every row (table-fixed layout —
// the task-run column absorbs the remaining width). Batch and Execution
// only exist as columns from xl up; below that the five visible columns
// fit without a scrollbar (the traces and runs tables hide columns the
// same way).
const COL = {
  trigger: 170,
  batch: 90,
  hosts: 160,
  execution: 170,
  judges: 100,
  duration: 105,
  started: 130,
} as const;

function TaskRunPassBar({ value, muted }: { value: number; muted?: boolean }) {
  if (muted) return <span className="font-mono text-[12px] text-muted-foreground">&mdash;</span>;
  const color = value >= 80 ? "bg-success" : value < 50 ? "bg-destructive" : "bg-foreground/30";
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1 w-12 overflow-hidden rounded-full bg-border">
        <div className={cn("h-full", color)} style={{ width: `${value}%` }} />
      </div>
      <span className="w-8 text-right font-mono text-[12px] tabular-nums text-muted-foreground">{value}%</span>
    </div>
  );
}

/** Judge counts in the three states (running / no verdict yet / final). */
function JudgesCounts({ run }: { run: AgentTaskRunSummary }) {
  const isRunning = run.status === "running";
  const isInactive = run.status === "pending" || run.status === "error";
  if (isRunning) {
    return (
      <span className="font-mono tabular-nums text-muted-foreground">
        {run.passed_checks}/{run.total_checks}
      </span>
    );
  }
  if (isInactive || run.total_checks === 0) {
    return <span className="font-mono text-muted-foreground">&mdash;</span>;
  }
  return (
    <span className="inline-flex items-center font-mono tabular-nums">
      <span className="text-success">{run.passed_checks}</span>
      <span className="text-muted-foreground">/</span>
      <span className="text-destructive">{run.failed_checks}</span>
      <span className="text-muted-foreground">/</span>
      <span className="text-muted-foreground">{run.total_checks}</span>
    </span>
  );
}

function RunDuration({ run }: { run: AgentTaskRunSummary }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[13px] tabular-nums text-foreground">
      <Clock className="h-3 w-3 text-muted-foreground" />
      {formatTaskRunDuration(run.started_at, run.completed_at)}
    </span>
  );
}

function RunCost({ run }: { run: AgentTaskRunSummary }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[12px] tabular-nums text-muted-foreground">
      <DollarSign className="h-3 w-3 text-muted-foreground" />
      {run.total_cost != null && run.total_cost > 0 ? formatCostMicro(run.total_cost) : "\u2014"}
    </span>
  );
}

function RunTokens({ run }: { run: AgentTaskRunSummary }) {
  if (run.total_tokens == null || run.total_tokens <= 0) return null;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[12px] tabular-nums text-muted-foreground">
      <Hash className="h-3 w-3 text-muted-foreground" />
      {formatTokenTotal(run.total_tokens)}
    </span>
  );
}

export function TaskRunRow({
  run,
  projectId,
  compareSelected = false,
  compareDisabled = false,
  onToggleCompare,
  canDelete = false,
  onDelete,
}: {
  run: AgentTaskRunSummary;
  projectId: string;
  /** Optional compare toggle (task page). When omitted, no compare button renders. */
  compareSelected?: boolean;
  compareDisabled?: boolean;
  onToggleCompare?: () => void;
  /** Optional delete action (batch detail / task history). When either
   * prop is omitted, no delete button renders. */
  canDelete?: boolean;
  onDelete?: () => void;
}) {
  const router = useRouter();
  const status = run.status;
  const statusConfig = taskRunStatusConfig(status);
  const isDone = status === "passed" || status === "failed";
  const passRate = run.total_checks > 0 ? Math.round((run.passed_checks / run.total_checks) * 100) : 0;
  const href = `/project/${projectId}/runs/task/${run.id}`;
  const hasCompare = typeof onToggleCompare === "function";

  return (
    <TableRow
      className="group cursor-pointer border-border/60 transition-colors hover:bg-muted/30"
      onClick={(event) => {
        if (!shouldIgnoreTaskRunNavigation(event.target)) router.push(href);
      }}
    >
      <TableCell className="max-w-[300px] pl-6">
        <div className="flex items-center gap-2.5">
          <span className={cn("h-2 w-2 shrink-0 rounded-full", statusConfig.dot)} aria-hidden />
          <span className="sr-only">{statusConfig.label}</span>
          <Link
            href={href}
            className="truncate text-[14px] font-medium text-foreground hover:text-primary"
            title={run.task_id}
          >
            {run.task_id}
          </Link>
          <span className={cn("shrink-0 text-[11px] font-medium uppercase tracking-wide", statusConfig.text)}>
            {runStatusLabel(run, statusConfig.label)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[12px] text-muted-foreground">
          <span className="font-mono text-muted-foreground">{run.id.slice(0, 10)}</span>
          {run.status === "running" && run.trace_run_id && (
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
            <span
              className={cn(
                "truncate",
                errorMessageTextClass(run),
              )}
              title={run.error_message}
            >
              {run.error_message.slice(0, 80)}
            </span>
          )}
        </div>
      </TableCell>

      <TableCell className="max-w-[190px]" style={{ width: COL.trigger }}>
        <TriggerBadge trigger={run.trigger} />
      </TableCell>

      <TableCell className="hidden font-mono text-[12px] text-muted-foreground xl:table-cell" style={{ width: COL.batch }}>
        {run.batch_run_id.slice(0, 8)}
      </TableCell>

      {/* Hosts — the serving providers/routes the run actually used
       * (issue #307); absent host renders an em dash, not "unknown". */}
      <TableCell className="hidden max-w-[160px] xl:table-cell" style={{ width: COL.hosts }}>
        <HostLabelsCell labels={providerLabels(run.model_providers)} />
      </TableCell>

      {/* Execution — model · effort. Full qualified name on hover. */}
      <TableCell className="hidden max-w-[190px] xl:table-cell" style={{ width: COL.execution }}>
        <span
          className="block truncate font-mono text-[12px] tabular-nums text-muted-foreground"
          title={formatRunExecutionFull(run.run_configuration)}
        >
          {run.run_configuration ? formatRunExecution(run.run_configuration) : "\u2014"}
        </span>
      </TableCell>

      <TableCell className="text-right" style={{ width: COL.judges }}>
        <JudgesCounts run={run} />
        <div className="mt-1">
          <TaskRunPassBar value={passRate} muted={!isDone} />
        </div>
      </TableCell>

      <TableCell className="text-right" style={{ width: COL.duration }}>
        <RunDuration run={run} />
        <div className="mt-0.5"><RunCost run={run} /></div>
        <div className="mt-0.5"><RunTokens run={run} /></div>
      </TableCell>

      <TableCell className="pr-6 text-right" style={{ width: COL.started }}>
        <div className="flex items-center justify-end gap-2">
          <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
            {formatTaskRunRelativeTime(run.started_at)}
          </span>
          {hasCompare && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleCompare?.();
              }}
              disabled={compareDisabled}
              aria-pressed={compareSelected}
              aria-label={compareSelected ? "Remove from comparison" : "Add to comparison"}
              title={compareDisabled ? "Clear a selection to compare this run" : compareSelected ? "Selected for comparison" : "Compare this run"}
              className={cn(
                "grid h-6 w-6 place-items-center rounded border transition-colors",
                compareSelected
                  ? "border-foreground bg-foreground text-background"
                  : compareDisabled
                    ? "cursor-not-allowed border-border text-muted-foreground/30"
                    : "border-border text-muted-foreground hover:border-foreground/50 hover:text-foreground",
              )}
            >
              <GitCompare className="h-3.5 w-3.5" />
            </button>
          )}
          {canDelete && onDelete && (
            <DeleteRunButton
              target={{ kind: "task-run", taskRunId: run.id }}
              canDelete={canDelete}
              onDeleted={onDelete}
            />
          )}
          <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
      </TableCell>
    </TableRow>
  );
}

export function TaskRunListHeader() {
  return (
    <TableHeader>
      <TableRow className="border-border hover:bg-transparent">
        <TableHead className="pl-6">Task run</TableHead>
        <TableHead style={{ width: COL.trigger }}>Trigger</TableHead>
        <TableHead className="hidden xl:table-cell" style={{ width: COL.batch }}>Batch</TableHead>
        <TableHead className="hidden xl:table-cell" style={{ width: COL.hosts }}>Hosts</TableHead>
        <TableHead className="hidden xl:table-cell" style={{ width: COL.execution }}>Execution</TableHead>
        <TableHead className="text-right" style={{ width: COL.judges }}>Judges</TableHead>
        <TableHead className="text-right" style={{ width: COL.duration }}>Duration</TableHead>
        <TableHead className="pr-6 text-right" style={{ width: COL.started }}>Started</TableHead>
      </TableRow>
    </TableHeader>
  );
}

/** Compact serving-host labels for a table cell; shared by every task-run
 * row rendering (issue #307). */
export function HostLabelsCell({ labels }: { labels: string[] }) {
  if (labels.length === 0) {
    return <span className="text-muted-foreground/50">&mdash;</span>;
  }
  return (
    <span
      className="block truncate font-mono text-[12px] text-muted-foreground"
      title={labels.join(" · ")}
    >
      {labels.join(" · ")}
    </span>
  );
}

function shouldIgnoreTaskRunNavigation(target: EventTarget | null) {
  return target instanceof HTMLElement
    && target.closest("a, button, input, select, textarea, [role='button'], [role='link']") !== null;
}
