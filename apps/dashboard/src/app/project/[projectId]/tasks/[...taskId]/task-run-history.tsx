"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { GitCompare, Play, X } from "lucide-react";
import { type AgentTaskRunSummary } from "@/lib/agent-task-api";
import { Button } from "@/components/ui/button";
import { Table, TableBody } from "@/components/ui/table";
import { ListPagination } from "@/components/table";
import { TaskRunListHeader, TaskRunRow } from "@/components/task-run-list";

import { useProjectId } from "@/lib/project-router";

const PAGE_SIZE = 20;

interface TaskRunHistoryProps {
  runs: AgentTaskRunSummary[];
  /** Caller's project role allows run deletion (owner/admin). */
  canDelete?: boolean;
}

export function TaskRunHistory({ runs, canDelete = false }: TaskRunHistoryProps) {
  const projectId = useProjectId();
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  // Deleted runs are hidden locally until the next server render; deriving
  // the list from the prop (instead of copying it into state once) keeps a
  // parent re-render with fresh `runs` from showing stale rows.
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => new Set());
  const liveRuns = runs.filter((run) => !deletedIds.has(run.id));

  // Deleted runs splice out locally; the surrounding counts refresh with
  // the next server render.
  const handleDeleted = (runId: string) => {
    setDeletedIds((prev) => new Set(prev).add(runId));
    setCompareIds((prev) => prev.filter((id) => id !== runId));
  };

  const totalPages = Math.ceil(liveRuns.length / PAGE_SIZE);
  // A refresh can shrink the list (run deleted) — clamp into range.
  const safePage = Math.min(page, Math.max(0, totalPages - 1));
  const visibleRuns = liveRuns.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  // Map selected run ids → their parent batch ids. Compare is only meaningful
  // across two DIFFERENT batches (comparing a batch to itself is nonsensical).
  const compareBatches = useMemo(() => {
    return compareIds
      .map((rid) => runs.find((r) => r.id === rid && !deletedIds.has(r.id))?.batch_run_id)
      .filter((b): b is string => typeof b === "string");
  }, [compareIds, runs, deletedIds]);
  const canCompare =
    compareIds.length === 2 && compareBatches.length === 2 && compareBatches[0] !== compareBatches[1];

  const toggleCompare = (id: string) => {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      // Cap at two; replace the older (second) slot when adding a third.
      return prev.length >= 2 ? [prev[1], id] : [...prev, id];
    });
  };

  if (!liveRuns || liveRuns.length === 0) {
    return (
      <div className="m-6 rounded-md border border-dashed border-border bg-card/40 p-10 text-center text-[13px] text-muted-foreground">
        No runs yet.{" "}
        <Link href={`/project/${projectId}/tasks`} className="underline underline-offset-4 hover:text-foreground">
          Run this task
        </Link>
      </div>
    );
  }

  const compareIdSet = new Set(compareIds);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-end border-b border-border px-6 py-3">
        <Button type="button" asChild size="sm" className="h-7 gap-1.5 text-[12px] font-medium">
          <Link href={`/project/${projectId}/tasks`}>
            <Play className="h-3 w-3 fill-current" />
            Run again
          </Link>
        </Button>
      </div>

      <Table density="compact" className="min-w-[560px]">
        <TaskRunListHeader />
        <TableBody>
          {visibleRuns.map((run) => (
            <TaskRunRow
              key={run.id}
              run={run}
              projectId={projectId}
              compareSelected={compareIdSet.has(run.id)}
              compareDisabled={compareIds.length >= 2 && !compareIdSet.has(run.id)}
              onToggleCompare={() => toggleCompare(run.id)}
              canDelete={canDelete}
              onDelete={() => handleDeleted(run.id)}
            />
          ))}
        </TableBody>
      </Table>

      <ListPagination
        totalCount={liveRuns.length}
        page={safePage}
        pageSize={PAGE_SIZE}
        totalPages={totalPages}
        itemName="task runs"
        onPageChange={setPage}
      />

      {/* Compare bar — appears when one or two runs are selected. Compares the
          two parent batch runs (same-batch pairs are disabled: a batch vs
          itself is meaningless). */}
      {compareIds.length > 0 && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t border-border bg-background/95 px-6 py-3 text-[12px] backdrop-blur">
          <GitCompare className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">
            <span className="font-medium text-foreground">{compareIds.length}</span> of 2 runs selected
            {compareIds.length === 2 && !canCompare && (
              <span className="ml-2 text-warning">pick two from different batches to compare</span>
            )}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-[12px] font-medium text-muted-foreground"
              onClick={() => setCompareIds([])}
            >
              <X className="h-3 w-3" /> Clear
            </Button>
            {canCompare && (
              <Button type="button" asChild size="sm" className="h-7 gap-1.5 text-[12px] font-medium">
                <Link href={`/project/${projectId}/runs/compare?a=${compareBatches[0]}&b=${compareBatches[1]}`}>
                  <GitCompare className="h-3 w-3" /> Compare batches
                </Link>
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
