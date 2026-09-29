"use client";

import Link from "next/link";
import { ArrowUpRight, Clock } from "lucide-react";
import { useSearchParams } from "next/navigation";

import { type AgentTaskRunSummary } from "@/lib/agent-task-api";
import { taskRunStatusConfig } from "@/components/task-run-list.utils";
import { DeleteRunButton } from "@/components/runs/DeleteRunButton";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatCostMicro, formatTokenTotal } from "@/lib/format";
import { formatRunExecution, formatRunExecutionFull } from "@/lib/run-configuration";
import { hrefWithRunCohort, parseDrilldownCohort } from "@/lib/run-cohort";

import { formatDuration, formatRelative } from "./runs-utils";

/** A single task run nested under its parent batch run row. */
export function InlineTaskRunRow({
  run,
  projectId,
  clientNow,
  canDelete,
  onDeleted,
}: {
  run: AgentTaskRunSummary;
  projectId: string;
  clientNow: number | null;
  /** Caller's project role allows run deletion (owner/admin). */
  canDelete: boolean;
  /** Splices this row out of the parent's task-run list. */
  onDeleted: () => void;
}) {
  const status = run.status;
  const statusConfig = taskRunStatusConfig(status);
  const isDone = status === "passed" || status === "failed";
  const isInactive = status === "pending" || status === "error";
  const passRate = run.total_checks > 0 ? Math.round((run.passed_checks / run.total_checks) * 100) : 0;
  // Scope loop: the Runs page's URL cohort travels into run detail
  // (single-model selections only — the drill-down vocabulary has no
  // comma-joined multi-model form).
  const cohort = parseDrilldownCohort(Object.fromEntries(useSearchParams().entries()));
  const runHref = hrefWithRunCohort(`/project/${projectId}/runs/task/${run.id}`, cohort);

  return (
    <TableRow className="group cursor-default border-border/60 bg-white/10 transition-colors hover:bg-white/15">
      <TableCell className="border-l-2 border-l-white/30 px-2 py-3" />

      <TableCell className="pl-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", statusConfig.dot)} aria-hidden />
            <span className="sr-only">{statusConfig.label}</span>
            <Link
              href={runHref}
              className="truncate text-[13px] font-medium text-foreground hover:text-primary"
            >
              {run.task_id}
            </Link>
          </div>
          <div className="mt-1 flex items-center gap-x-2 text-[11px] text-muted-foreground">
            {run.adapter_name && (
              <span className="shrink-0 font-mono text-muted-foreground/60">{run.adapter_name}</span>
            )}
            {run.error_message && (
              <>
                <span className="shrink-0 text-muted-foreground/30">·</span>
                <span className="truncate text-destructive">{run.error_message.slice(0, 80)}</span>
              </>
            )}
          </div>
        </div>
      </TableCell>

      <TableCell aria-hidden className="hidden xl:table-cell" />

      <TableCell>
        <span
          className="truncate font-mono text-[12px] tabular-nums text-muted-foreground"
          title={formatRunExecutionFull(run.run_configuration)}
        >
          {formatRunExecution(run.run_configuration)}
        </span>
      </TableCell>

      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-2 font-mono text-[12px] tabular-nums">
          {isInactive || run.total_checks === 0 ? (
            <span className="text-muted-foreground">&mdash;</span>
          ) : (
            <>
              <span className={cn("tabular-nums", status === "passed" ? "text-success" : status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                {passRate}%
              </span>
              <span className="text-muted-foreground/40">·</span>
              <span className="text-muted-foreground">{run.passed_checks}/{run.total_checks} checks</span>
              {(run.errored_checks ?? 0) > 0 && (
                <span
                  className="text-warning"
                  title="Checks that produced no verdict (judge error) — unknown, not failed"
                >
                  {" "}{run.errored_checks}!
                </span>
              )}
            </>
          )}
        </div>
        {isDone && run.total_checks > 0 && (
          <div className="mt-1.5 flex justify-end">
            <div className="h-1 w-24 overflow-hidden rounded-full bg-border">
              <div
                className={cn("h-full", passRate >= 95 ? "bg-success" : passRate < 80 ? "bg-destructive" : "bg-foreground/30")}
                style={{ width: `${passRate}%` }}
              />
            </div>
          </div>
        )}
      </TableCell>

      <TableCell className="text-right">
        <div className="inline-flex items-center justify-end gap-1.5 font-mono text-[12px] tabular-nums text-foreground">
          <Clock className="h-3 w-3 text-muted-foreground/50" />
          {formatDuration(run.started_at, run.completed_at, status === "running")}
        </div>
        {run.total_cost != null && run.total_cost > 0 && (
          <div className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
            {formatCostMicro(run.total_cost)}
          </div>
        )}
        {run.total_tokens != null && run.total_tokens > 0 && (
          <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {formatTokenTotal(run.total_tokens)}
          </div>
        )}
      </TableCell>

      <TableCell>
        <div className="flex items-center justify-end gap-2">
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {formatRelative(run.started_at, clientNow)}
          </span>
          <DeleteRunButton
            target={{ kind: "task-run", taskRunId: run.id }}
            canDelete={canDelete}
            onDeleted={onDeleted}
          />
          <Link
            href={runHref}
            aria-label={`Open task run ${run.id}`}
            data-testid={`task-run-link-${run.id}`}
            className="text-muted-foreground transition-opacity hover:text-foreground"
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </TableCell>
    </TableRow>
  );
}
