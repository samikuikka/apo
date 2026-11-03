"use client";

import { SelectAllRow } from "./SelectAllRow";
import { FolderRow } from "./FolderRow";
import { type FolderNode } from "./task-list-shared";

/**
 * The folder-grouped task list: root select-all row, one FolderRow per
 * folder, and the "no tasks match" empty state for the current query.
 * Selection and expansion state stay in the parent (they are shared with
 * the toolbar / evidence views bar) and flow down as props.
 */
export function FolderList({
  folders,
  expanded,
  selected,
  isDemoProject,
  query,
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
  /** Cards render capture-honest copy (dates, idle labels) in the demo. */
  isDemoProject: boolean;
  query: string;
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

  return (
    <div className="px-6 py-1">
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
          isDemoProject={isDemoProject}
          toggleFolder={onToggleFolder}
          toggleTask={onToggleTask}
          toggleExpand={onToggleExpand}
        />
      ))}

      {folders.length === 0 && query && (
        <div className="m-6 border border-dashed border-border bg-muted/10 p-10 text-center text-[13px] text-muted-foreground">
          No tasks match <span className="font-mono text-foreground/70">&quot;{query}&quot;</span>
        </div>
      )}
    </div>
  );
}
