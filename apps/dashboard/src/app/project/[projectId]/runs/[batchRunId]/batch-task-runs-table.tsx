"use client";

import { useState } from "react";

import { ListPagination } from "@/components/table";
import { TaskRunListHeader, TaskRunRow } from "@/components/task-run-list";
import type { AgentTaskRunSummary } from "@/lib/agent-task-api";
import { Table, TableBody } from "@/components/ui/table";

const PAGE_SIZE = 20;

/** The batch run's task runs, in the shared task-run table with paging. */
export function BatchTaskRunsTable({
  runs,
  projectId,
  canDelete,
}: {
  runs: AgentTaskRunSummary[];
  projectId: string;
  /** Caller's project role allows run deletion (owner/admin). */
  canDelete: boolean;
}) {
  const [page, setPage] = useState(0);
  // Deleted runs are hidden locally until the next server render; deriving
  // the list from the prop (instead of copying it into state once) keeps a
  // parent re-render with fresh `runs` from showing stale rows.
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => new Set());
  const liveRuns = runs.filter((run) => !deletedIds.has(run.id));

  // Deleted runs splice out locally; deleting the last one removes the
  // whole batch, so head back to the runs list.
  const handleDeleted = (runId: string) => {
    setDeletedIds((prev) => new Set(prev).add(runId));
    if (liveRuns.length <= 1) {
      window.location.href = `/project/${projectId}/runs`;
    }
  };

  const totalPages = Math.ceil(liveRuns.length / PAGE_SIZE);
  // A refresh can shrink the list — clamp into range.
  const safePage = Math.min(page, Math.max(0, totalPages - 1));
  const visibleRuns = liveRuns.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  return (
    <div className="flex flex-col">
      <Table density="compact" className="min-w-[560px]">
        <TaskRunListHeader />
        <TableBody>
          {visibleRuns.map((run) => (
            <TaskRunRow
              key={run.id}
              run={run}
              projectId={projectId}
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
    </div>
  );
}
