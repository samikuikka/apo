"use client";

import Link from "next/link";
import {
  type ColumnDef,
} from "@tanstack/react-table";
import {
  Badge,
} from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CopyIdPopover } from "@/components/trace-detail/CopyIdPopover";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  CheckCircle2,
  Star,
  AlertCircle,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatInterval, formatCostMicro, tokenFormat, formatRelativeTime } from "@/lib/format";
import { sortedMetric, heatFraction, heatColor } from "@/lib/heatmap";
import type {
  TraceMetric,
  TraceSummary,
} from "@/lib/traces-api";
// Column metadata is co-located in a .ts module so this file exports only
// React components (keeps Fast Refresh able to preserve component state).
export { COLUMN_LABELS, COLUMN_SORT_MAP } from "./column-constants";

function getMetric(metrics: TraceMetric[], name: string): number | null {
  const m = metrics.find((m) => m.metric_name === name);
  return m ? m.score : null;
}

function StatusDot({ status: _status, errorCount, warningCount }: { status: string; errorCount: number; warningCount: number }) {
  if (errorCount > 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center justify-center">
            <AlertCircle className="h-3.5 w-3.5 text-destructive" />
            {errorCount > 1 && <span className="ml-0.5 text-[10px] text-destructive">{errorCount}</span>}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">{errorCount} error{errorCount !== 1 ? "s" : ""}</TooltipContent>
      </Tooltip>
    );
  }
  if (warningCount > 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center justify-center">
            <AlertTriangle className="h-3.5 w-3.5 text-warning" />
            {warningCount > 1 && <span className="ml-0.5 text-[10px] text-warning">{warningCount}</span>}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">{warningCount} warning{warningCount !== 1 ? "s" : ""}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center justify-center">
          <CheckCircle2 className="h-3.5 w-3.5 text-[var(--success)]" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">Success</TooltipContent>
    </Tooltip>
  );
}

function StarToggle({ bookmarked, onClick, readOnly }: { bookmarked: boolean; onClick: () => void; readOnly?: boolean }) {
  return (
    <button
      type="button"
      disabled={readOnly}
      className="inline-flex h-6 w-6 items-center justify-center rounded-sm hover:bg-muted/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={bookmarked ? "Remove bookmark" : "Add bookmark"}
      title={readOnly ? "Demo workspace is read-only" : undefined}
    >
      <Star
        className={cn(
          "h-4 w-4 transition-colors",
          bookmarked ? "fill-amber-400 text-amber-400" : "text-foreground/50 hover:text-foreground",
        )}
      />
    </button>
  );
}

function LatencyCell({ ms, sorted }: { ms: number | null; sorted: number[] }) {
  if (ms == null || ms <= 0) return <span className="text-muted-foreground/50">{"\u2014"}</span>;
  const color = heatColor(heatFraction(ms, sorted));
  return (
    <span
      className="text-nowrap font-mono text-xs tabular-nums"
      style={{ color }}
    >
      {formatInterval(ms)}
    </span>
  );
}

function UsageCell({ metrics, primaryModel, sortedCosts }: { metrics: TraceMetric[]; primaryModel?: string | null; sortedCosts: number[] }) {
  const prompt = getMetric(metrics, "prompt_tokens");
  const completion = getMetric(metrics, "completion_tokens");
  const total = getMetric(metrics, "total_tokens") ?? (prompt != null && completion != null ? prompt + completion : null);
  // SPEC-136: cost is now a stored micro-USD int (no client-side pricing fetch).
  const cost = getMetric(metrics, "total_cost");

  if (total == null && cost == null) return <span className="text-muted-foreground/50">{"\u2014"}</span>;

  const tokenParts: string[] = [];
  if (prompt != null) tokenParts.push(tokenFormat(prompt));
  if (prompt != null && completion != null) tokenParts.push("\u2192");
  if (completion != null) tokenParts.push(tokenFormat(completion));
  if (total != null) tokenParts.push(`(\u2211 ${tokenFormat(total)})`);

  const costColor = cost != null && cost > 0 ? heatColor(heatFraction(cost, sortedCosts)) : undefined;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default text-nowrap font-mono text-xs tabular-nums text-foreground">
          {tokenParts.length > 0 ? tokenParts.join(" ") : null}
          {cost != null && cost > 0 && (
            <span style={costColor ? { color: costColor } : undefined}>
              {tokenParts.length > 0 ? " " : ""}{"\u00b7"} {formatCostMicro(cost)}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        <div className="space-y-0.5">
          {primaryModel && primaryModel !== "unknown" && <div className="font-medium">{primaryModel}</div>}
          {prompt != null && (
            <div>
              Prompt: {tokenFormat(prompt)}
            </div>
          )}
          {completion != null && (
            <div>
              Completion: {tokenFormat(completion)}
            </div>
          )}
          {total != null && <div>Total: {tokenFormat(total)}</div>}
          {cost != null && cost > 0 && (
            <div className="border-t border-background/20 pt-0.5">
              Cost: {formatCostMicro(cost)}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function TraceNameCell({ trace, projectId }: { trace: TraceSummary; projectId: string }) {
  const name = trace.scopeKey || trace.task_id || "Untitled";
  const scopeLabel = trace.scopeKey
    ? trace.scopeKey === "agent-task.e2e" ? "E2E" : trace.scopeKey
    : null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      {scopeLabel && (
        <span className="inline-flex shrink-0 items-center rounded-sm border border-border/60 bg-muted/40 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {scopeLabel}
        </span>
      )}
      <Link
        href={`/project/${projectId}/traces/${trace.id}`}
        onClick={(e) => e.stopPropagation()}
        className="truncate text-xs font-medium text-foreground hover:text-primary hover:underline"
      >
        {name}
      </Link>
    </div>
  );
}

function CallsBadge({ count }: { count: number }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 rounded-sm px-1.5 font-mono text-[11px] tabular-nums",
        count > 10 ? "border-warning/30 bg-warning/10 text-warning" : "text-muted-foreground",
      )}
    >
      {count}
    </Badge>
  );
}

function RelativeTimeCell({ value }: { value: string | null }) {
  const text = !value ? "\u2014" : formatRelativeTime(value);
  return <span className="text-xs text-muted-foreground tabular-nums">{text}</span>;
}

export function SortableHeader({
  column,
  label,
  onSort,
}: {
  column: any;
  label: string;
  onSort: () => void;
}) {
  const sorted = column.getIsSorted();
  return (
    <button
      type="button"
      className="flex items-center gap-1 hover:text-foreground transition-colors"
      onClick={onSort}
    >
      <span>{label}</span>
      <span className="inline-flex h-3 w-3 shrink-0">
        {sorted === "desc" ? (
          <ArrowDown className="h-3 w-3" />
        ) : sorted === "asc" ? (
          <ArrowUp className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-30" />
        )}
      </span>
    </button>
  );
}

// This factory composes the StatusDot/SortableHeader components defined above;
// moving it out would create a circular dep (factory needs the components).
// react-doctor-disable-next-line react-doctor/only-export-components
export function createTraceColumns(
  selectActionColumn: ColumnDef<TraceSummary>,
  onToggleBookmark: (runId: string) => void,
  projectId: string,
  readOnly: boolean = false,
): ColumnDef<TraceSummary>[] {
  return [
    selectActionColumn,
    {
      id: "bookmark",
      header: "",
      size: 40,
      enableSorting: false,
      cell: ({ row }) => (
        <StarToggle
          bookmarked={row.original.bookmarked}
          readOnly={readOnly}
          onClick={() => onToggleBookmark(row.original.id)}
        />
      ),
    },
    {
      id: "status",
      header: "Status",
      size: 50,
      enableSorting: false,
      cell: ({ row }) => (
        <StatusDot
          status={row.original.status}
          errorCount={row.original.error_count}
          warningCount={row.original.warning_count}
        />
      ),
    },
    {
      accessorKey: "id",
      header: "ID",
      size: 140,
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-1.5">
          <CopyIdPopover ids={[{ label: "Trace ID", value: row.original.id }]}>
            <span className="font-mono text-xs text-primary hover:underline cursor-pointer"
              onClick={(e) => e.stopPropagation()}
            >
              {row.original.id.length > 16 ? `${row.original.id.slice(0, 16)}...` : row.original.id}
            </span>
          </CopyIdPopover>
          <Link
            href={`/project/${projectId}/traces/${row.original.id}`}
            className="text-muted-foreground/50 hover:text-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>
      ),
    },
    {
      id: "name",
      header: "Name",
      size: 180,
      enableSorting: false,
      cell: ({ row }) => <TraceNameCell trace={row.original} projectId={projectId} />,
    },
    {
      id: "task",
      header: "Task",
      size: 120,
      enableSorting: false,
      cell: ({ row }) => {
        const taskId = row.original.task_id;
        if (!taskId) return <span className="text-muted-foreground/50">{"\u2014"}</span>;
        return (
          <Badge variant="outline" className="rounded-sm px-1.5 py-0 font-normal text-[10px] text-muted-foreground">
            {taskId}
          </Badge>
        );
      },
    },
    {
      accessorKey: "environment",
      header: "Env",
      size: 80,
      enableSorting: false,
      cell: ({ row }) => {
        const env = row.original.environment;
        if (!env || env === "default") return <span className="text-muted-foreground/50">{"\u2014"}</span>;
        return (
          <Badge variant="outline" className="rounded-sm px-1 py-0 font-normal text-[10px]">
            {env}
          </Badge>
        );
      },
    },
    {
      accessorKey: "primary_model",
      header: "Model",
      size: 120,
      enableSorting: false,
      cell: ({ row }) => {
        const model = row.original.primary_model;
        if (!model) return <span className="text-muted-foreground/50">{"\u2014"}</span>;
        const short = model.includes("/") ? model.split("/").pop()! : model;
        return (
          <span className="block truncate text-xs text-muted-foreground" title={model}>{short}</span>
        );
      },
    },
    {
      id: "tags",
      header: "Tags",
      size: 120,
      enableSorting: false,
      cell: ({ row }) => {
        const tags = row.original.tags;
        if (!tags?.length) return <span className="text-muted-foreground/50">{"\u2014"}</span>;
        return (
          <div className="flex items-center gap-1 overflow-hidden">
            {tags.slice(0, 2).map((tag) => (
              <Badge key={tag} variant="outline" className="shrink-0 rounded-sm px-1 py-0 font-normal text-[10px]">
                {tag}
              </Badge>
            ))}
            {tags.length > 2 && (
              <span className="text-[10px] text-muted-foreground">+{tags.length - 2}</span>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "call_count",
      header: "Calls",
      size: 70,
      enableSorting: true,
      cell: ({ row }) => <CallsBadge count={row.original.call_count} />,
    },
    {
      id: "latency",
      header: "Latency",
      size: 100,
      enableSorting: true,
      accessorFn: (row) => row.duration_ms ?? 0,
      cell: ({ row, table }) => {
        const rows = table.getRowModel().rows;
        const sorted = sortedMetric(rows, "duration", (r) => r.original.duration_ms ?? 0);
        return <LatencyCell ms={row.original.duration_ms} sorted={sorted} />;
      },
    },
    {
      id: "usage",
      header: "Usage",
      size: 200,
      enableSorting: false,
      accessorFn: (row) => getMetric(row.metrics, "total_tokens") ?? 0,
      cell: ({ row, table }) => {
        const rows = table.getRowModel().rows;
        const sortedCosts = sortedMetric(rows, "total_cost", (r) => getMetric(r.original.metrics, "total_cost") ?? 0);
        return <UsageCell metrics={row.original.metrics} primaryModel={row.original.primary_model} sortedCosts={sortedCosts} />;
      },
    },
    {
      id: "input_preview",
      header: "Input",
      size: 160,
      cell: ({ row }) => {
        const preview = row.original.input_preview;
        if (!preview) return <span className="text-muted-foreground/50">{"\u2014"}</span>;
        return (
          <span
            className="block truncate rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
            title={preview}
          >
            {preview}
          </span>
        );
      },
    },
    {
      id: "output_preview",
      header: "Output",
      size: 160,
      cell: ({ row }) => {
        const preview = row.original.output_preview;
        if (!preview) return <span className="text-muted-foreground/50">{"\u2014"}</span>;
        return (
          <span
            className="block truncate rounded bg-success/5 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
            title={preview}
          >
            {preview}
          </span>
        );
      },
    },
    {
      accessorKey: "created_at",
      header: "Created",
      size: 120,
      enableSorting: true,
      cell: ({ row }) => <RelativeTimeCell value={row.original.created_at} />,
    },
  ];
}
