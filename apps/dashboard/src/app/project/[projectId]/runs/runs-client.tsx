"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import {
  ArrowUpRight,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Clock,
  GitBranch,
  GitCompare,
  History,
  Loader2,
  Play,
  Search,
  User,
  Zap,
} from "lucide-react";
import {
  type AgentTaskBatchRunSummary,
  type AgentTaskRunSummary,
  getAgentTaskBatchRun,
} from "@/lib/agent-task-api";
import { type ProjectTaskSource } from "@/lib/projects-api";
import { ProjectTaskSourceEmptyState } from "@/components/project-task-source";
import { TASK_RUN_STATUS, type TaskRunStatus } from "@/components/task-run-list.utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { parseUTC, formatCostMicro } from "@/lib/format";

import { useProjectId } from "@/lib/project-router";
import { useClientNow } from "@/hooks/use-client-now";
import {
  conclusionStyle,
  deriveConclusion,
  type Conclusion,
} from "@/components/run-outcome";
import { useUrlParam } from "@/hooks/use-url-state";

type ConclusionFilter = "all" | "running" | "passed" | "failed";

/**
 * Column widths — fixed, not flexible. Mirrors the traces table's approach:
 * with `table-fixed` (baked into our <Table> primitive) the browser honors
 * these widths as authoritative and truncates overflowing cell content instead
 * of growing the table past its container. Only the Run column holds variable
 * (long) text; everything else is bounded.
 */
const COL = {
  chevron: 28,
  run: "auto", // flexible remainder — the only column without a px cap
  source: 150,
  tasks: 180,
  duration: 110,
  created: 150,
} as const;

/** Coarse bucket for the filter tabs: "problems" groups failed + errored. */
function filterBucket(c: Conclusion): ConclusionFilter {
  if (c === "running" || c === "queued") return "running";
  if (c === "passed") return "passed";
  return "failed";
}

function formatDate(value: string | null): string {
  if (!value) return "\u2014";
  const d = parseUTC(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function formatRelative(value: string | null, nowMs: number | null): string {
  if (!value) return "\u2014";
  if (nowMs === null) return "\u2026";
  const date = parseUTC(value);
  const diffMs = nowMs - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return formatDate(value);
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start) return "\u2014";
  const startMs = parseUTC(start).getTime();
  const endMs = end ? parseUTC(end).getTime() : Date.now();
  const ms = endMs - startMs;
  if (ms < 0) return "\u2014";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

function formatTrigger(trigger: { source: string | null; actor: string | null; schedule_name?: string | null } | null): string {
  if (!trigger) return "Manual";
  if (trigger.source === "schedule") {
    return trigger.schedule_name ? `Scheduled · ${trigger.schedule_name}` : "Scheduled";
  }
  if (trigger.source === "manual") return "Manual";
  if (trigger.source === "ci") return "CI / Pipeline";
  if (trigger.actor) return trigger.actor;
  return trigger.source ?? "Manual";
}

function getSelectionLabel(batch: AgentTaskBatchRunSummary): string {
  const q = batch.selection_query;
  if (q && typeof q === "object" && "task_paths" in q) {
    const paths = q.task_paths;
    if (Array.isArray(paths) && paths.length > 0) {
      return paths.length === 1 ? (paths[0] as string) : `${paths.length} tasks`;
    }
  }
  if (batch.selection_type === "all") return "All tasks";
  return batch.selection_type;
}

export function RunsClient({
  batchRuns,
  error: _error,
  taskSource,
}: {
  batchRuns: AgentTaskBatchRunSummary[];
  error: string | null;
  taskSource: ProjectTaskSource | null;
}) {
  const projectId = useProjectId();
  // Filter state lives in the URL (?q=, ?filter=) so a shared link lands the
  // reader on the same filtered view.
  const [query, setQuery] = useUrlParam("q");
  const [filterParam, setFilter] = useUrlParam("filter", "all");
  const filter: ConclusionFilter =
    filterParam === "running" || filterParam === "passed" || filterParam === "failed"
      ? filterParam
      : "all";
  const clientNow = useClientNow();
  const sourceUnconfigured = taskSource === null && batchRuns.length === 0;

  // Compare selection: at most two batch ids, chosen here (not on the compare
  // page) so you can see the runs and their overlap in context before deciding
  // what to compare.
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const compareIdSet = useMemo(() => new Set(compareIds), [compareIds]);
  const toggleCompare = useCallback((id: string) => {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      // Cap at two; replace the older (second) slot when adding a third.
      return prev.length >= 2 ? [prev[1], id] : [...prev, id];
    });
  }, []);
  const clearCompare = useCallback(() => setCompareIds([]), []);

  const selectedBatches = useMemo(
    () => compareIds.map((id) => batchRuns.find((b) => b.id === id)).filter((b): b is AgentTaskBatchRunSummary => !!b),
    [compareIds, batchRuns],
  );
  const overlap = useMemo(
    () => (selectedBatches.length === 2 ? computeOverlap(selectedBatches[0], selectedBatches[1]) : null),
    [selectedBatches],
  );

  const conclusions = useMemo(
    () =>
      batchRuns.map((b) =>
        deriveConclusion({
          status: b.status,
          passed: b.passed_tasks,
          failed: b.failed_tasks,
          errored: b.errored_tasks,
          total: b.total_tasks,
        }),
      ),
    [batchRuns],
  );

  const counts = useMemo(() => {
    const c: Record<ConclusionFilter, number> = { all: batchRuns.length, running: 0, passed: 0, failed: 0 };
    for (const con of conclusions) c[filterBucket(con)]++;
    return c;
  }, [batchRuns.length, conclusions]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return batchRuns.filter((b, i) => {
      if (filter !== "all" && filterBucket(conclusions[i]) !== filter) return false;
      if (!q) return true;
      return (
        b.id.includes(q) ||
        b.selection_type.toLowerCase().includes(q) ||
        getSelectionLabel(b).toLowerCase().includes(q) ||
        (b.trigger?.actor?.toLowerCase().includes(q) ?? false) ||
        (b.trigger?.source?.toLowerCase().includes(q) ?? false) ||
        b.environment.toLowerCase().includes(q)
      );
    });
  }, [query, filter, batchRuns, conclusions]);

  return (
    <div className="flex h-full w-full flex-col">
      {/* Toolbar — stays fixed above the scroll region. */}
      <div className="shrink-0 border-b border-border bg-background">
        <div className="flex flex-col gap-3 px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span>Agent Testing</span>
            <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
            <span className="text-foreground">Runs</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border px-6 py-2.5">
          <div className="relative max-w-md min-w-[240px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by ID, selection, source, actor, or task name..."
              className="h-8 border-border bg-card pl-8 text-[13px] placeholder:text-muted-foreground/50 focus-visible:ring-1"
            />
          </div>
          <div className="flex items-center gap-1 rounded-md border border-border bg-card p-0.5">
            {(["all", "running", "passed", "failed"] as ConclusionFilter[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={cn(
                  "inline-flex h-6 items-center gap-1.5 rounded px-2 text-[12px] font-medium capitalize transition-colors",
                  filter === k ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {k}
                <span className={cn("font-mono text-[10px] tabular-nums", filter === k ? "text-background/60" : "text-muted-foreground/60")}>
                  {counts[k] ?? 0}
                </span>
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-3 text-[12px] text-muted-foreground">
            <span>
              <span className="font-medium text-foreground">{filtered.length}</span> runs
            </span>
          </div>
        </div>
      </div>

      {/* Scroll region — the table scrolls here while toolbar + footer stay
          fixed. The sticky table header sticks to the top of THIS container,
          not the page, which is what makes it behave like the traces table. */}
      <div className="flex-1 overflow-auto">
        {sourceUnconfigured ? (
          <div className="px-6 py-10">
            <ProjectTaskSourceEmptyState projectId={projectId} scope="batch-runs" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="m-6 rounded-md border border-dashed border-border bg-card/40 p-10 text-center text-[13px] text-muted-foreground">
            <History className="mx-auto mb-2 h-5 w-5 text-muted-foreground/50" />
            {batchRuns.length === 0
              ? <>No runs yet. <Link href={`/project/${projectId}/tasks`} className="text-primary underline underline-offset-4">Discover and run tasks</Link></>
              : "No runs match your filters."}
          </div>
        ) : (
          <Table density="compact">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow className="border-border hover:bg-transparent">
                <TableHead style={{ width: COL.chevron }} />
                <TableHead>Run</TableHead>
                <TableHead style={{ width: COL.source }}>Source</TableHead>
                <TableHead style={{ width: COL.tasks }} className="text-right">Tasks · Pass rate</TableHead>
                <TableHead style={{ width: COL.duration }} className="text-right">Duration</TableHead>
                <TableHead style={{ width: COL.created }} className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((b) => (
                <RunsRow
                  key={b.id}
                  batch={b}
                  clientNow={clientNow}
                  projectId={projectId}
                  compareSelected={compareIdSet.has(b.id)}
                  compareDisabled={compareIds.length >= 2 && !compareIdSet.has(b.id)}
                  onToggleCompare={() => toggleCompare(b.id)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-border px-6 py-3 text-[12px] text-muted-foreground">
        <span>Showing <span className="font-mono text-foreground">{filtered.length}</span> of <span className="font-mono text-foreground">{batchRuns.length}</span> runs</span>
      </div>

      {/* Compare bar — appears when one or two runs are selected for comparison.
          Shows the task overlap so you can tell, before navigating, whether the
          two runs actually share enough tasks to be worth comparing. */}
      {selectedBatches.length > 0 && (
        <div className="sticky bottom-4 z-20 mx-auto mb-4 w-fit">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 shadow-2xl shadow-black/60">
            <GitCompare className="h-4 w-4 text-muted-foreground" />
            <div className="flex items-center gap-2 text-[12px]">
              {selectedBatches.map((b, i) => (
                <span key={b.id} className="flex items-center gap-1.5">
                  {i > 0 && <span className="text-muted-foreground/40">vs</span>}
                  <span className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                    {getBatchName(b)}
                  </span>
                </span>
              ))}
              {selectedBatches.length === 2 && (
                <span className="text-muted-foreground">
                  {overlap ? (
                    overlap.shared === 0 ? (
                      <span className="text-muted-foreground/70">no shared tasks</span>
                    ) : (
                      <>
                        <span className="font-mono tabular-nums text-foreground">{overlap.shared}</span> shared
                        {overlap.onlyA > 0 && (
                          <> · <span className="font-mono tabular-nums">{overlap.onlyA}</span> only A</>
                        )}
                        {overlap.onlyB > 0 && (
                          <> · <span className="font-mono tabular-nums">{overlap.onlyB}</span> only B</>
                        )}
                      </>
                    )
                  ) : (
                    <span className="text-muted-foreground/60">overlap unknown</span>
                  )}
                </span>
              )}
            </div>
            <div className="h-5 w-px bg-border" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[12px] font-normal text-muted-foreground hover:text-foreground"
              onClick={clearCompare}
            >
              Clear
            </Button>
            {selectedBatches.length === 2 && overlap !== null && overlap.shared === 0 ? (
              <span className="text-[12px] text-muted-foreground/70">Nothing to compare</span>
            ) : selectedBatches.length === 2 ? (
              <Button
                type="button"
                size="sm"
                className="h-7 gap-1.5 px-3 text-[12px] font-medium"
                asChild
              >
                <Link href={`/project/${projectId}/runs/compare?a=${compareIds[0]}&b=${compareIds[1]}`}>
                  Compare
                </Link>
              </Button>
            ) : (
              <span className="text-[12px] text-muted-foreground">Select one more</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function getTaskPaths(batch: AgentTaskBatchRunSummary): string[] {
  const q = batch.selection_query;
  if (q && typeof q === "object" && "task_paths" in q) {
    const paths = q.task_paths;
    if (Array.isArray(paths)) return paths.map((p: string) => p.split("/").pop() ?? p);
  }
  return [];
}

/** Full task paths (un-stripped) — needed to compute overlap between two
 *  batches accurately. Falls back to the batch id when the selection has no
 *  explicit paths (e.g. "all" / "grep"), so those never falsely overlap. */
function getFullTaskPaths(batch: AgentTaskBatchRunSummary): string[] {
  const q = batch.selection_query;
  if (q && typeof q === "object" && "task_paths" in q) {
    const paths = q.task_paths;
    if (Array.isArray(paths) && paths.length > 0) return paths as string[];
  }
  // "all" and similar selections have no enumerable path list — represent as
  // empty so overlap is honestly unknown, not spuriously 100%.
  return [];
}

/** Overlap between two batches by task path. Returns shared/onlyA/onlyB counts
 *  and null when at least one side has no enumerable paths (overlap unknown). */
function computeOverlap(
  a: AgentTaskBatchRunSummary,
  b: AgentTaskBatchRunSummary,
): { shared: number; onlyA: number; onlyB: number } | null {
  const aPaths = new Set(getFullTaskPaths(a));
  const bPaths = new Set(getFullTaskPaths(b));
  if (aPaths.size === 0 || bPaths.size === 0) return null;
  let shared = 0;
  for (const p of aPaths) if (bPaths.has(p)) shared++;
  return { shared, onlyA: aPaths.size - shared, onlyB: bPaths.size - shared };
}

function getBatchName(batch: AgentTaskBatchRunSummary): string {
  const paths = getTaskPaths(batch);
  if (paths.length === 1) return paths[0];
  if (paths.length > 1) return `${paths.length} tasks`;
  if (batch.selection_type === "all") return "All discovered tasks";
  return batch.selection_type;
}

function getSourceIcon(source: string | null): React.ComponentType<{ className?: string }> {
  if (source === "schedule") return CalendarClock;
  if (source === "ci") return GitBranch;
  if (source === "dashboard") return Play;
  return Zap;
}

/**
 * A run row, rendered as two <tr>s inside the table body:
 *   1. The main row (chevron, name, source, tasks, duration, created).
 *   2. When expanded, a child <tr> with a single <td colSpan> holding the
 *      lazy-loaded task runs.
 *
 * Using table-fixed (from <Table>) + explicit column widths means the Run
 * column — the only one without a px width — absorbs free space, and its
 * `min-w-0` + `truncate` content clips instead of pushing the table wider.
 */
function RunsRow({
  batch,
  clientNow,
  projectId,
  compareSelected,
  compareDisabled,
  onToggleCompare,
}: {
  batch: AgentTaskBatchRunSummary;
  clientNow: number | null;
  projectId: string;
  compareSelected: boolean;
  compareDisabled: boolean;
  onToggleCompare: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [taskRuns, setTaskRuns] = useState<AgentTaskRunSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const s = conclusionStyle({
    status: batch.status,
    passed: batch.passed_tasks,
    failed: batch.failed_tasks,
    errored: batch.errored_tasks,
    total: batch.total_tasks,
  });
  // Pass rate is check-level (Σ passed_checks / Σ total_checks) — "how well did
  // it do". Comparable across batch sizes and matches the child rows. The
  // task-level fraction (passed_tasks/total_tasks) is shown beside it as the
  // "did every task fully pass" signal. See plan: check-level leads.
  const checkTotal = Math.max(batch.total_checks, 1);
  const passRate = Math.round((batch.passed_checks / checkTotal) * 100);
  const isRunning = batch.status === "running";
  const showRate = batch.total_checks > 0 || !isRunning;
  const triggerLabel = formatTrigger(batch.trigger);
  const SourceIcon = getSourceIcon(batch.trigger?.source ?? null);
  const batchName = getBatchName(batch);
  const taskPaths = getTaskPaths(batch);
  const branch = (batch.trigger as Record<string, unknown> | null)?.branch as string | null;
  const commit = (batch.trigger as Record<string, unknown> | null)?.commit_sha as string | null;

  // Lazy-load child task runs the first time the row is expanded. Cached in
  // state so re-collapsing/expanding doesn't re-fetch.
  const handleToggle = useCallback(async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && taskRuns === null && !loading) {
      setLoading(true);
      setError(null);
      try {
        const detail = await getAgentTaskBatchRun(batch.id);
        setTaskRuns(detail.task_runs ?? []);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Failed to load task runs");
      } finally {
        setLoading(false);
      }
    }
  }, [expanded, taskRuns, loading, batch.id]);

  return (
    <>
      <TableRow className="group cursor-default border-border/60 transition-colors hover:bg-muted/30">
        {/* Expand chevron — only for batches with >1 task. A single-task batch
            is just the task run; expanding would echo the same name, so it has
            nothing to reveal. The row title links to batch detail instead. */}
        <TableCell className="px-2">
          {batch.total_tasks > 1 ? (
            <button
              type="button"
              onClick={handleToggle}
              aria-label={expanded ? "Collapse task runs" : "Expand task runs"}
              aria-expanded={expanded}
              className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {loading
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded ? "" : "-rotate-90")} />}
            </button>
          ) : null}
        </TableCell>

        {/* Run name + meta — the only column without a fixed width. min-w-0 +
            truncate on the link keeps long names from pushing the table wider. */}
        <TableCell>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", s.dot)} aria-hidden />
              <Link
                href={`/project/${projectId}/runs/${batch.id}`}
                className="truncate text-[14px] font-medium text-foreground hover:text-primary"
              >
                {batchName}
              </Link>
              <span className={cn("shrink-0 text-[11px] font-medium uppercase tracking-wide", s.text)}>
                {s.label}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
              <span className="shrink-0 font-mono text-muted-foreground/60">{batch.id.slice(0, 8)}</span>
              <span className="shrink-0 text-muted-foreground/30">·</span>
              <span className="inline-flex shrink-0 items-center gap-1">
                <User className="h-3 w-3 text-muted-foreground/50" />
                <span className="font-mono">{triggerLabel}</span>
              </span>
              {branch && (
                <>
                  <span className="shrink-0 text-muted-foreground/30">·</span>
                  <span className="inline-flex shrink-0 items-center gap-1">
                    <GitBranch className="h-3 w-3 text-muted-foreground/50" />
                    <span className="font-mono">{branch}</span>
                    {commit && <span className="font-mono text-muted-foreground/50">@{commit.slice(0, 7)}</span>}
                  </span>
                </>
              )}
              {taskPaths.length > 1 && (
                <>
                  <span className="shrink-0 text-muted-foreground/30">·</span>
                  <span className="shrink-0 truncate text-muted-foreground">
                    {taskPaths.slice(0, 3).join(" · ")}
                    {taskPaths.length > 3 && <span className="ml-1">+{taskPaths.length - 3}</span>}
                  </span>
                </>
              )}
            </div>
          </div>
        </TableCell>

        <TableCell>
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded border border-border bg-card">
              <SourceIcon className="h-3 w-3 text-muted-foreground" />
            </span>
            <div className="min-w-0">
              <div className="truncate font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {triggerLabel}
              </div>
              <div className="truncate font-mono text-[10px] text-muted-foreground/60">{batch.selection_type}</div>
            </div>
          </div>
        </TableCell>

        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-2 font-mono text-[13px] tabular-nums">
            <span className={cn(
              "tabular-nums",
              showRate
                ? (passRate >= 95 ? "text-success" : passRate >= 80 ? "text-foreground" : "text-destructive")
                : "text-muted-foreground",
            )}>{showRate ? `${passRate}%` : "—"}</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="text-muted-foreground text-[12px]">{batch.passed_tasks}/{batch.total_tasks} tasks</span>
          </div>
          <div className="mt-1.5 flex justify-end">
            {isRunning ? (
              <span className="font-mono text-[11px] text-muted-foreground">running...</span>
            ) : (
              <div className="h-1 w-24 overflow-hidden rounded-full bg-border">
                <div
                  className={cn("h-full", passRate >= 95 ? "bg-success" : passRate < 80 ? "bg-destructive" : "bg-foreground/30")}
                  style={{ width: `${passRate}%` }}
                />
              </div>
            )}
          </div>
        </TableCell>

        <TableCell className="text-right">
          <div className="inline-flex items-center justify-end gap-1.5 font-mono text-[13px] tabular-nums text-foreground">
            <Clock className="h-3 w-3 text-muted-foreground/50" />
            {formatDuration(batch.started_at, batch.completed_at)}
          </div>
        </TableCell>

        <TableCell>
          <div className="flex items-center justify-end gap-2">
            <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
              {formatRelative(batch.created_at, clientNow)}
            </span>
            <button
              type="button"
              onClick={onToggleCompare}
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
            <Link
              href={`/project/${projectId}/runs/${batch.id}`}
              aria-label="Open batch run"
              className="text-muted-foreground transition-opacity hover:text-foreground"
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </TableCell>
      </TableRow>

      {/* Expanded child task runs. Rendered as real <TableRow>s that SHARE the
          parent's column schema (not a foreign grid in a colSpan cell) so the
          parent's pass-rate reads as the honest aggregate of its children.
          Tinted + indented to frame the hierarchy without faking alignment. */}
      {expanded && (
        <>
          {loading && (
            <TableRow className="bg-white/10 hover:bg-transparent">
              <TableCell colSpan={6} className="py-6">
                <div className="flex items-center justify-center gap-2 text-[12px] text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading task runs…
                </div>
              </TableCell>
            </TableRow>
          )}
          {!loading && error && (
            <TableRow className="bg-white/10 hover:bg-transparent">
              <TableCell colSpan={6} className="py-6 text-center text-[12px] text-destructive">{error}</TableCell>
            </TableRow>
          )}
          {!loading && !error && taskRuns !== null && taskRuns.length === 0 && (
            <TableRow className="bg-white/10 hover:bg-transparent">
              <TableCell colSpan={6} className="py-6 text-center text-[12px] text-muted-foreground">
                No task runs were recorded for this run.
              </TableCell>
            </TableRow>
          )}
          {!loading && !error && taskRuns !== null && taskRuns.map((run) => (
            <InlineTaskRunRow key={run.id} run={run} projectId={projectId} clientNow={clientNow} />
          ))}
        </>
      )}
    </>
  );
}

/**
 * A child task run rendered inside an expanded batch row. Mirrors the parent's
 * column layout (Run · Source · Tasks·Pass rate · Duration · Created) so the
 * family reads as one table: the batch row is the aggregate, these are its
 * parts. Visually distinguished by the muted background + left indent bar so
 * it's clear these are drill-down details, not sibling batches.
 */
function InlineTaskRunRow({ run, projectId, clientNow }: { run: AgentTaskRunSummary; projectId: string; clientNow: number | null }) {
  const status = run.status in TASK_RUN_STATUS ? (run.status as TaskRunStatus) : "pending";
  const statusConfig = TASK_RUN_STATUS[status];
  const isDone = status === "passed" || status === "failed";
  const isInactive = status === "pending" || status === "error";
  const passRate = run.total_checks > 0 ? Math.round((run.passed_checks / run.total_checks) * 100) : 0;

  return (
    <TableRow className="group cursor-default border-border/60 bg-white/10 transition-colors hover:bg-white/15">
      {/* Continuous left edge — the strongest hierarchy cue. A solid border
          running the full row height reads as "these rows are grouped",
          unlike a per-row tint which the eye dismisses as noise. The status
          dot in the name cell already shows pass/fail, so no marker needed here. */}
      <TableCell className="border-l-2 border-l-white/30 px-2 py-3" />

      {/* Run name: task_id + status dot. Indented (pl-3) from the batch name
          so the child visibly nests under its parent, not just via tint. */}
      <TableCell className="pl-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", statusConfig.dot)} aria-hidden />
            <Link
              href={`/project/${projectId}/runs/task/${run.id}`}
              className="truncate text-[13px] font-medium text-foreground hover:text-primary"
            >
              {run.task_id}
            </Link>
            <span className={cn("shrink-0 text-[11px] font-medium uppercase tracking-wide", statusConfig.text)}>
              {statusConfig.label}
            </span>
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

      <TableCell>
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {run.task_path.split("/").slice(-2).join("/")}
        </span>
      </TableCell>

      {/* Tasks · Pass rate — checks here, same column + same visual language. */}
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
          {formatDuration(run.started_at, run.completed_at)}
        </div>
        {run.total_cost != null && run.total_cost > 0 && (
          <div className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
            {formatCostMicro(run.total_cost)}
          </div>
        )}
      </TableCell>

      <TableCell>
        <div className="flex items-center justify-end gap-2">
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {formatRelative(run.started_at, clientNow)}
          </span>
          <Link
            href={`/project/${projectId}/runs/task/${run.id}`}
            aria-label="Open task run"
            className="text-muted-foreground transition-opacity hover:text-foreground"
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </TableCell>
    </TableRow>
  );
}
