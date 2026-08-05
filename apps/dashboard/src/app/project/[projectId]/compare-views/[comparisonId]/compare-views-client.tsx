"use client";

// Renders an immutable selection-scoped view comparison (SPEC-174 Phase 2).
//
// One row per task in the snapshot, grouped by folder: side A status | side B
// status | a verdict derived from the status transition. Tasks the two sides
// disagree on revisions (def/exec) stay visible but show `n/c` and are excluded
// from the aggregate coverage.

import { useMemo } from "react";
import Link from "next/link";
import { ArrowLeft, Folder, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useProjectId } from "@/lib/project-router";
import { taskDetailHref } from "@/lib/task-routes";
import type { AgentTaskSummary } from "@/lib/agent-task-api";
import type { ResolvedComparisonCell, TaskViewComparisonSnapshot, TaskViewConfig } from "@/lib/agent-task-view-api";

export function CompareViewsClient({
  projectId: projectIdProp,
  snapshot,
  tasks,
}: {
  projectId: string;
  snapshot: TaskViewComparisonSnapshot;
  tasks: AgentTaskSummary[];
}) {
  // read the project id from the URL too (hooks must run unconditionally); the
  // server-passed value is authoritative for the initial render.
  const routeProjectId = useProjectId();
  const projectId = projectIdProp || routeProjectId;

  const taskMap = useMemo(() => {
    const m = new Map(tasks.map((t) => [t.id, t]));
    return m;
  }, [tasks]);

  const groups = useMemo(() => {
    const byFolder: Record<string, ResolvedComparisonCell[]> = {};
    for (const cell of snapshot.resolved) {
      const folder = taskMap.get(cell.task_id)?.folder_path || "(removed)";
      (byFolder[folder] ??= []).push(cell);
    }
    return Object.entries(byFolder).map(([folder, cells]) => ({ folder, cells }));
  }, [snapshot.resolved, taskMap]);

  const viewLabel = (v: TaskViewConfig) => {
    const parts = [v.model ?? "All models"];
    if (v.effort) parts.push(v.effort);
    return parts.join(" · ");
  };

  return (
    <div className="flex flex-col">
      {/* Header: scope + rule + both view configs + coverage */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <Link
          href={`/project/${projectId}/tasks`}
          className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground/70"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Tasks
        </Link>
        <span className="font-medium text-foreground/80">
          Comparing {snapshot.coverage.scope} task{snapshot.coverage.scope === 1 ? "" : "s"}
        </span>
        <span className="text-muted-foreground/50">·</span>
        <span className="text-[12px] text-muted-foreground/60">latest run per task</span>
        <div className="flex items-center gap-2">
          <span className="grid h-4 min-w-4 place-items-center bg-warning px-1 font-mono text-[10px] font-semibold text-black">A</span>
          <span className="font-mono text-[11px] text-muted-foreground">{viewLabel(snapshot.view_a_config)}</span>
          <span className="text-muted-foreground/40">vs</span>
          <span className="grid h-4 min-w-4 place-items-center bg-foreground px-1 font-mono text-[10px] font-semibold text-black">B</span>
          <span className="font-mono text-[11px] text-muted-foreground">{viewLabel(snapshot.view_b_config)}</span>
        </div>
        <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
          <span className="text-foreground/80">{snapshot.coverage.both_run}</span>
          <span className="text-muted-foreground/50">/{snapshot.coverage.scope} Run</span>
          <span className="text-muted-foreground/30"> · </span>
          <span className="text-foreground/80">{snapshot.coverage.comparable}</span>
          <span className="text-muted-foreground/50">/{snapshot.coverage.scope} Comparable</span>
        </span>
      </div>

      <div className="px-6 py-1">
        {groups.map(({ folder, cells }) => (
          <FolderGroup key={folder} folder={folder} cells={cells} taskMap={taskMap} projectId={projectId} />
        ))}
      </div>
    </div>
  );
}

function FolderGroup({
  folder,
  cells,
  taskMap,
  projectId,
}: {
  folder: string;
  cells: ResolvedComparisonCell[];
  taskMap: Map<string, AgentTaskSummary>;
  projectId: string;
}) {
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex items-center gap-2 px-2 py-2">
        <Folder className="h-4 w-4 text-muted-foreground" />
        <span className="font-mono text-[13px] font-medium">{folder}</span>
        <span className="bg-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{cells.length}</span>
      </div>
      <div className="space-y-px pb-2">
        {cells.map((cell) => {
          const task = taskMap.get(cell.task_id);
          const name = task?.display_name ?? cell.task_id;
          return (
            <div key={cell.task_id} className="flex items-center gap-3 border border-transparent px-2 py-2 hover:bg-card/40">
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
              <Link
                href={taskDetailHref(projectId, cell.task_id)}
                className="min-w-0 flex-1 hover:text-foreground/70"
                title={cell.task_id}
              >
                <div className="truncate text-[13px] font-medium">{name}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground/40">{cell.task_id}</div>
              </Link>
              <div className="flex w-[120px] shrink-0 items-center justify-end border-l border-warning/20 pl-3">
                <StatusPill status={cell.a_status} resolved={cell.a_run_id !== null} />
              </div>
              <div className="flex w-[120px] shrink-0 items-center justify-end border-l border-border pl-3">
                <StatusPill status={cell.b_status} resolved={cell.b_run_id !== null} />
              </div>
              <div className="flex w-[90px] shrink-0 justify-end border-l border-border pl-3">
                <Verdict cell={cell} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatusPill({ status, resolved }: { status: string | null; resolved: boolean }) {
  if (!resolved || status === null) {
    return <span className="font-mono text-[12px] text-muted-foreground/50">Not Run</span>;
  }
  const map: Record<string, { label: string; cls: string; dot: string }> = {
    passed: { label: "Passed", cls: "text-success", dot: "bg-success" },
    failed: { label: "Failed", cls: "text-destructive", dot: "bg-destructive" },
    error: { label: "Errored", cls: "text-warning", dot: "bg-warning" },
  };
  const s = map[status] ?? { label: status, cls: "text-muted-foreground", dot: "bg-muted-foreground" };
  return (
    <span className={cn("flex items-center gap-1.5 font-mono text-[12px]", s.cls)}>
      <span className={cn("h-2 w-2 rounded-full", s.dot)} aria-hidden />
      {s.label}
    </span>
  );
}

function Verdict({ cell }: { cell: ResolvedComparisonCell }) {
  if (!cell.comparable) {
    return <span className="border border-warning/40 px-1 font-mono text-[10px] text-warning" title="Revisions differ or a side has no run — excluded from aggregate">n/c</span>;
  }
  const aPass = cell.a_status === "passed";
  const bPass = cell.b_status === "passed";
  if (aPass === bPass) {
    return <span className="font-mono text-[10px] text-muted-foreground/60">same</span>;
  }
  if (!aPass && bPass) {
    return <span className="font-mono text-[10px] text-success" title="B passed where A did not">improved</span>;
  }
  return <span className="font-mono text-[10px] text-destructive" title="B did not pass where A did">regressed</span>;
}
