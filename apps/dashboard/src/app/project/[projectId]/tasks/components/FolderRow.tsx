"use client";

import { ChevronRight, Folder, FolderOpen } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

import { PassBar } from "./PassBar";
import { TaskCard } from "./TaskCard";
import { type FolderNode, getTaskStatus } from "./task-list-shared";

export function FolderRow({
  folder,
  state,
  isOpen,
  selected,
  isDemoProject,
  toggleFolder,
  toggleTask,
  toggleExpand,
}: {
  folder: FolderNode;
  state: "none" | "some" | "all";
  isOpen: boolean;
  selected: Set<string>;
  isDemoProject: boolean;
  toggleFolder: (folder: FolderNode) => void;
  toggleTask: (id: string) => void;
  toggleExpand: (id: string) => void;
}) {
  const selectedCount = folder.tasks.filter((t) => selected.has(t.id)).length;
  const runnableTasks = folder.tasks.filter((t) => t.run_stats && (t.run_stats.pass_rate > 0 || t.run_stats.last_run_status));
  const folderPass = runnableTasks.length > 0
    ? Math.round(runnableTasks.reduce((s, t) => s + (t.run_stats?.pass_rate ?? 0), 0) / runnableTasks.length * 100)
    : 0;

  return (
    <div key={folder.id} className="border-b border-border last:border-b-0 py-2">
      {/* Folder row */}
      <div
        className={cn(
          "group flex items-center gap-3 px-2 py-2 transition-colors",
          state !== "none" ? "bg-card/40" : "hover:bg-muted/10",
        )}
      >
        <Checkbox
          checked={state === "all" ? true : state === "some" ? "indeterminate" : false}
          onCheckedChange={() => toggleFolder(folder)}
          aria-label={`Select all in ${folder.id}`}
        />
        <button type="button"
          onClick={() => toggleExpand(folder.id)}
          className="grid h-5 w-5 place-items-center text-muted-foreground/60 hover:bg-border hover:text-foreground/70"
          aria-label={isOpen ? "Collapse" : "Expand"}
        >
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-90")} />
        </button>
        <button type="button"
          onClick={() => toggleExpand(folder.id)}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          {isOpen ? (
            <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-mono text-[14px] font-medium">{folder.id}</span>
          <span className="bg-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {folder.tasks.length} tasks
          </span>
          {selectedCount > 0 && (
            <span className="bg-white px-1.5 py-0.5 font-mono text-[11px] font-medium text-black">
              {selectedCount} selected
            </span>
          )}
        </button>
        <div className="hidden shrink-0 items-center gap-2 text-[12px] text-muted-foreground sm:flex" style={{ width: "160px" }}>
          {runnableTasks.length > 0 && (
            <>
              <span className="text-muted-foreground/60">Pass</span>
              <div className="w-28"><PassBar value={folderPass / 100} /></div>
            </>
          )}
        </div>
      </div>

      {/* Task cards */}
      {isOpen && (
        <div className="mt-1 space-y-1">
          {folder.tasks.map((task) => {
            const isSel = selected.has(task.id);
            const status = getTaskStatus(task);
            return (
              <TaskCard
                key={task.id}
                task={task}
                isSel={isSel}
                status={status}
                stats={task.run_stats}
                isDemoProject={isDemoProject}
                toggleTask={toggleTask}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
