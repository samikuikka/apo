"use client";

import { useMemo, useState } from "react";
import { ChevronRight, CheckIcon, Folder, FolderOpen, Search } from "lucide-react";
import { type AgentTaskSummary } from "@/lib/agent-task-api";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { groupTasksByFolder, type FolderNode } from "./task-folder-select.utils";

export type FolderCheckState = "none" | "some" | "all";

export interface TaskFolderSelectProps {
  /** All tasks available for selection. */
  tasks: AgentTaskSummary[];
  /** Controlled selection: a Set of task ids. */
  selected: Set<string>;
  /** Called with the next Set whenever selection changes. */
  onSelectedChange: (next: Set<string>) => void;
  /** Search input placeholder. */
  searchPlaceholder?: string;
  /** Show the toolbar (filter + expand/collapse-all + clear). Defaults to true. */
  showToolbar?: boolean;
  /** Optional className for the root container. */
  className?: string;
}

/**
 * Folder-structure task selector. Renders tasks grouped by `folder_path`
 * as a collapsible tree with tri-state folder checkboxes, mirroring the
 * selection UX on the agent-tasks page. Controlled via `selected`.
 */
export function TaskFolderSelect({
  tasks,
  selected,
  onSelectedChange,
  searchPlaceholder = "Filter tasks...",
  showToolbar = true,
  className,
}: TaskFolderSelectProps) {
  const folders = useMemo(() => groupTasksByFolder(tasks), [tasks]);

  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(folders.map((f) => f.id)),
  );
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query) return folders;
    const q = query.toLowerCase();
    return folders.reduce<FolderNode[]>((acc, folder) => {
      const folderMatches = folder.id.toLowerCase().includes(q);
      const folderTasks = folderMatches
        ? folder.tasks
        : folder.tasks.filter(
            (t) =>
              t.display_name.toLowerCase().includes(q) ||
              t.task_path.toLowerCase().includes(q),
          );
      if (folderTasks.length > 0) {
        acc.push({ ...folder, tasks: folderTasks });
      }
      return acc;
    }, []);
  }, [query, folders]);

  const toggleTask = (taskId: string) => {
    const next = new Set(selected);
    if (next.has(taskId)) next.delete(taskId);
    else next.add(taskId);
    onSelectedChange(next);
  };

  const toggleFolder = (folder: FolderNode) => {
    const ids = folder.tasks.map((t) => t.id);
    const allSelected = ids.every((id) => selected.has(id));
    const next = new Set(selected);
    if (allSelected) ids.forEach((id) => next.delete(id));
    else ids.forEach((id) => next.add(id));
    onSelectedChange(next);
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const folderState = (folder: FolderNode): FolderCheckState => {
    const ids = folder.tasks.map((t) => t.id);
    const count = ids.filter((id) => selected.has(id)).length;
    if (count === 0) return "none";
    if (count === ids.length) return "all";
    return "some";
  };

  const allFolderIds = folders.map((f) => f.id);
  const allExpanded =
    allFolderIds.length > 0 && allFolderIds.every((id) => expanded.has(id));

  return (
    <div className={cn("flex flex-col", className)}>
      {showToolbar && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 border-border bg-card pl-8 text-[13px] placeholder:text-muted-foreground/50 focus-visible:border-border"
            />
          </div>
          <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
            {selected.size > 0 && (
              <>
                <span>
                  <span className="font-medium text-foreground/70">
                    {selected.size}
                  </span>{" "}
                  selected
                </span>
                <button
                  type="button"
                  onClick={() => onSelectedChange(new Set())}
                  className="underline-offset-2 hover:text-foreground/70 hover:underline"
                >
                  Clear
                </button>
                <div className="h-4 w-px bg-border" />
              </>
            )}
            {allFolderIds.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  setExpanded(allExpanded ? new Set() : new Set(allFolderIds))
                }
                className="hover:text-foreground/70"
              >
                {allExpanded ? "Collapse all" : "Expand all"}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border/60">
        {filtered.length === 0 ? (
          <div className="m-4 rounded-md border border-dashed border-border bg-muted/10 p-6 text-center text-[13px] text-muted-foreground">
            {query ? (
              <>
                No tasks match{" "}
                <span className="font-mono text-foreground/70">&quot;{query}&quot;</span>
              </>
            ) : (
              "No tasks available"
            )}
          </div>
        ) : (
          filtered.map((folder) => {
            const state = folderState(folder);
            const isOpen = expanded.has(folder.id) || !!query;
            const selectedCount = folder.tasks.filter((t) =>
              selected.has(t.id),
            ).length;

            return (
              <div
                key={folder.id}
                className="border-b border-border last:border-b-0"
              >
                <div
                  className={cn(
                    "group flex items-center gap-3 px-2 py-2 transition-colors",
                    state !== "none" ? "bg-card/40" : "hover:bg-muted/10",
                  )}
                >
                  <Checkbox
                    checked={
                      state === "all"
                        ? true
                        : state === "some"
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={() => toggleFolder(folder)}
                    aria-label={`Select all in ${folder.id}`}
                  />
                  <button
                    type="button"
                    onClick={() => toggleExpand(folder.id)}
                    className="grid h-5 w-5 place-items-center rounded text-muted-foreground/60 hover:bg-border hover:text-foreground/70"
                    aria-label={isOpen ? "Collapse" : "Expand"}
                  >
                    <ChevronRight
                      className={cn(
                        "h-3.5 w-3.5 transition-transform",
                        isOpen && "rotate-90",
                      )}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleExpand(folder.id)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    {isOpen ? (
                      <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate font-mono text-[13px] font-medium">
                      {folder.id}
                    </span>
                    <span className="rounded bg-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                      {folder.tasks.length} tasks
                    </span>
                    {selectedCount > 0 && (
                      <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] font-medium text-black">
                        {selectedCount} selected
                      </span>
                    )}
                  </button>
                </div>

                {isOpen && (
                  <div className="pb-1">
                    {folder.tasks.map((task) => {
                      const isSel = selected.has(task.id);
                      return (
                        <button
                          key={task.id}
                          type="button"
                          onClick={() => toggleTask(task.id)}
                          aria-pressed={isSel}
                          className={cn(
                            "group/row flex w-full items-center gap-3 py-2 pl-10 pr-3 text-left transition-colors",
                            isSel ? "bg-muted/20" : "hover:bg-muted/10",
                          )}
                        >
                          <span
                            aria-hidden
                            className={cn(
                              "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                              isSel
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-foreground/40 bg-background shadow-sm hover:border-foreground/60",
                            )}
                          >
                            {isSel && <CheckIcon className="size-3.5" />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div
                              className={cn(
                                "truncate text-[13px]",
                                isSel
                                  ? "font-medium text-foreground"
                                  : "text-foreground/80",
                              )}
                            >
                              {task.display_name}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
