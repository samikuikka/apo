"use client";

import { Filter } from "lucide-react";

import { SelectAllRow } from "./SelectAllRow";
import { FolderRow } from "./FolderRow";
import { type FolderNode } from "./task-list-shared";

/**
 * The folder-grouped task list: root select-all row, one FolderRow per
 * folder, and the "no tasks match" empty state for the current query.
 * While a filter is in play the list leads with a notice saying how many of
 * the tasks it is showing and why: a search term persists in the URL, so a
 * reload lands on a filtered list the search box alone does not make obvious.
 * Selection and expansion state stay in the parent (they are shared with
 * the toolbar / evidence views bar) and flow down as props.
 */
export function FolderList({
  folders,
  expanded,
  selected,
  query,
  hasActiveFilters,
  onClearFilters,
  totalTaskCount,
  selectAllState,
  visibleTaskCount,
  onToggleSelectAll,
  onToggleFolder,
  onToggleTask,
  onToggleExpand,
}: {
  folders: FolderNode[];
  expanded: Set<string>;
  selected: Set<string>;
  query: string;
  /** Search or status narrowing the list (a view's cohort does not count). */
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  /** Tasks in the active view before search and status apply. */
  totalTaskCount: number;
  selectAllState: "none" | "some" | "all";
  visibleTaskCount: number;
  onToggleSelectAll: () => void;
  onToggleFolder: (folder: FolderNode) => void;
  onToggleTask: (id: string) => void;
  onToggleExpand: (id: string) => void;
}) {
  const folderState = (folder: FolderNode) => {
    const ids = folder.tasks.map((t) => t.id);
    const count = ids.filter((id) => selected.has(id)).length;
    if (count === 0) return "none" as const;
    if (count === ids.length) return "all" as const;
    return "some" as const;
  };

  const matching = query ? (
    <>
      {" "}
      matching{" "}
      <span className="font-mono text-foreground">&quot;{query}&quot;</span>
    </>
  ) : null;

  return (
    <div className="px-6 py-1">
      {hasActiveFilters && folders.length > 0 && (
        <div
          data-testid="tasks-filter-notice"
          className="mb-1 mt-1 flex items-center gap-2 border border-foreground/20 bg-muted/40 px-3 py-1.5 text-[12px] text-foreground/80"
        >
          <Filter className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Showing <span className="font-medium text-foreground">{visibleTaskCount}</span> of{" "}
            {totalTaskCount} {totalTaskCount === 1 ? "task" : "tasks"}
            {matching}
          </span>
          <button
            type="button"
            onClick={onClearFilters}
            className="ml-auto underline underline-offset-4 hover:text-foreground"
          >
            Clear filters
          </button>
        </div>
      )}
      {folders.length > 0 && (
        <SelectAllRow
          state={selectAllState}
          taskCount={visibleTaskCount}
          onToggle={onToggleSelectAll}
        />
      )}
      {folders.map((folder) => (
        <FolderRow
          key={folder.id}
          folder={folder}
          state={folderState(folder)}
          isOpen={expanded.has(folder.id) || !!query}
          selected={selected}
          toggleFolder={onToggleFolder}
          toggleTask={onToggleTask}
          toggleExpand={onToggleExpand}
        />
      ))}

      {folders.length === 0 && hasActiveFilters && (
        <div className="m-6 border border-dashed border-border bg-muted/10 p-10 text-center text-[13px] text-muted-foreground">
          {query ? (
            <>
              No tasks match{" "}
              <span className="font-mono text-foreground/70">&quot;{query}&quot;</span>
            </>
          ) : (
            "No tasks match the current filters"
          )}
          <div className="mt-3">
            <button
              type="button"
              onClick={onClearFilters}
              className="underline underline-offset-4 hover:text-foreground"
            >
              Clear filters
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
