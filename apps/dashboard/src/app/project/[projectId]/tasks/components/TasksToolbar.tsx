"use client";

import { Pencil, Play, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ProjectTaskSource } from "@/lib/projects-api";

export function TasksToolbar({
  taskSource,
  isDemoProject,
  canRunTasks = true,
  editingSource,
  syncing,
  selectedCount,
  runRunning,
  onEditSource,
  onSync,
  onRun,
}: {
  taskSource: ProjectTaskSource | null;
  isDemoProject: boolean;
  /** Hide (not disable) write affordances for read-only visitors. */
  canRunTasks?: boolean;
  editingSource: boolean;
  syncing: boolean;
  selectedCount: number;
  runRunning: boolean;
  onEditSource: () => void;
  onSync: () => void;
  onRun: () => void;
}) {
  return (
    <div className="border-b border-border bg-muted/10">
      <div className="flex flex-wrap items-center justify-end gap-2 px-6 py-3">
        {taskSource && !isDemoProject && canRunTasks && (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onEditSource}
              disabled={editingSource}
              className="h-8 gap-1.5 text-[13px] font-normal"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit source
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onSync}
              disabled={syncing}
              className="h-8 gap-1.5 text-[13px] font-normal"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
              {syncing ? "Syncing…" : "Resync"}
            </Button>
          </>
        )}
        {canRunTasks ? (
          <Button type="button"
            size="sm"
            disabled={selectedCount === 0 || runRunning || isDemoProject}
            onClick={onRun}
            title={isDemoProject ? "Demo workspace is read-only" : undefined}
            className="h-8 gap-1.5 text-[13px] font-medium disabled:opacity-40"
          >
            <Play className="h-3.5 w-3.5 fill-current" />
            {runRunning ? "Starting..." : selectedCount > 0 ? `Run ${selectedCount} task${selectedCount > 1 ? "s" : ""}` : "Run selected"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
