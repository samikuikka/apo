"use client";

// PROTOTYPE (throwaway) — shared state for the views-prototype variants.
// The domain shape under every variant: a view asks a question about a run
// population (the Cohort); the list answers it through scoped stats.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { AgentTaskSummary } from "@/lib/agent-task-api";
import type { RunConfigModelFacet } from "@/lib/agent-task-view-api";

import { groupByFolder, taskFilterStatus, STATUS_FILTER_KEYS, type FolderNode } from "../task-list-shared";

export interface VariantProps {
  projectId: string;
  tasks: AgentTaskSummary[];
  facets: RunConfigModelFacet[];
  seedViews: SeedView[];
}

export interface Cohort {
  model: string | null;
  effort: string | null;
  since: string | null;
  provider: string | null;
}

export const EMPTY_COHORT: Cohort = { model: null, effort: null, since: null, provider: null };

export interface ProtoView {
  id: string;
  label: string;
  cohort: Cohort;
  /** The committed snapshot; cohort may have drifted (the "modified" dot). */
  saved: Cohort;
  starred: boolean;
}

export type SeedView = Pick<ProtoView, "id" | "label"> & { cohort: Cohort };

export const SINCE_OPTIONS = ["7d", "30d", "90d"] as const;

export function cohortKey(c: Cohort): string {
  return `${c.model ?? ""}|${c.effort ?? ""}|${c.since ?? ""}|${c.provider ?? ""}`;
}

export function cohortIsEmpty(c: Cohort): boolean {
  return c.model === null && c.effort === null && c.since === null && c.provider === null;
}

export function cohortSummary(c: Cohort): string {
  if (cohortIsEmpty(c)) return "all history";
  const parts: string[] = [c.model ?? "all models"];
  if (c.effort) parts.push(c.effort);
  if (c.since) parts.push(`last ${c.since}`);
  if (c.provider) parts.push(c.provider);
  return parts.join(" · ");
}

let nextLocalId = 1;

export function useViewsProtoState(seedViews: SeedView[]) {
  const [views, setViews] = useState<ProtoView[]>(() => [
    { id: "main", label: "Main", cohort: EMPTY_COHORT, saved: EMPTY_COHORT, starred: true },
  ]);
  const [activeId, setActiveId] = useState("main");
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  // Saved views arrive async from the parent's fetch; merge by id once.
  useEffect(() => {
    setViews((prev) => {
      const known = new Set(prev.map((v) => v.id));
      const seeds = seedViews
        .filter((s) => !known.has(s.id))
        .map<ProtoView>((s) => ({ ...s, saved: s.cohort, starred: false }));
      return seeds.length > 0 ? [...prev, ...seeds] : prev;
    });
  }, [seedViews]);

  const active = views.find((v) => v.id === activeId) ?? views[0]!;

  const setCohort = useCallback(
    (patch: Partial<Cohort>) => {
      setViews((prev) =>
        prev.map((v) => (v.id === activeId ? { ...v, cohort: { ...v.cohort, ...patch } } : v)),
      );
    },
    [activeId],
  );

  const resetCohort = useCallback(() => {
    setViews((prev) => prev.map((v) => (v.id === activeId ? { ...v, cohort: v.saved } : v)));
  }, [activeId]);

  const commitActive = useCallback(() => {
    setViews((prev) => prev.map((v) => (v.id === activeId ? { ...v, saved: v.cohort } : v)));
  }, [activeId]);

  const saveAsNew = useCallback(
    (label: string) => {
      const id = `local-${nextLocalId++}`;
      setViews((prev) => {
        const activeNow = prev.find((v) => v.id === activeId) ?? prev[0]!;
        return [
          ...prev,
          { id, label, cohort: activeNow.cohort, saved: activeNow.cohort, starred: false },
        ];
      });
      setActiveId(id);
    },
    [activeId],
  );

  const renameActive = useCallback(
    (label: string) => {
      setViews((prev) => prev.map((v) => (v.id === activeId ? { ...v, label } : v)));
    },
    [activeId],
  );

  const removeView = useCallback((id: string) => {
    if (id === "main") return;
    setViews((prev) => prev.filter((v) => v.id !== id));
    setActiveId((cur) => (cur === id ? "main" : cur));
  }, []);

  const toggleStar = useCallback((id: string) => {
    setViews((prev) => prev.map((v) => (v.id === id ? { ...v, starred: !v.starred } : v)));
  }, []);

  return {
    views,
    active,
    activeId,
    setActiveId,
    cohort: active.cohort,
    isDirty: cohortKey(active.cohort) !== cohortKey(active.saved),
    setCohort,
    resetCohort,
    commitActive,
    saveAsNew,
    renameActive,
    removeView,
    toggleStar,
    statusFilter,
    setStatusFilter,
    query,
    setQuery,
  };
}

export type ViewsProtoState = ReturnType<typeof useViewsProtoState>;

/** Status + query filtering + folder grouping over the scoped task list. */
export function useFolderView(tasks: AgentTaskSummary[], state: ViewsProtoState) {
  const { statusFilter, query } = state;
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const folders = groupByFolder(tasks);
    return new Set(folders.map((f) => f.id));
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const noStatus = statusFilter.size === 0 || statusFilter.size === STATUS_FILTER_KEYS.length;
    const byStatus = noStatus ? tasks : tasks.filter((t) => statusFilter.has(taskFilterStatus(t)));
    const folders = groupByFolder(byStatus);
    if (!query) return folders;
    const q = query.toLowerCase();
    return folders.reduce<FolderNode[]>((acc, f) => {
      const fm = f.id.toLowerCase().includes(q);
      const fTasks = fm
        ? f.tasks
        : f.tasks.filter(
            (t) =>
              t.display_name.toLowerCase().includes(q) || t.task_path.toLowerCase().includes(q),
          );
      if (fTasks.length > 0) acc.push({ ...f, tasks: fTasks });
      return acc;
    }, []);
  }, [tasks, statusFilter, query]);

  const allFolderIds = useMemo(() => groupByFolder(tasks).map((f) => f.id), [tasks]);
  const allExpanded = allFolderIds.length > 0 && allFolderIds.every((id) => expanded.has(id));

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleTask = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const visibleTaskIds = filtered.flatMap((f) => f.tasks.map((t) => t.id));
  const selectedVisible = visibleTaskIds.filter((id) => selected.has(id)).length;
  const selectAllState: "none" | "some" | "all" =
    selectedVisible === 0 ? "none" : selectedVisible === visibleTaskIds.length ? "all" : "some";
  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const visible = filtered.flatMap((f) => f.tasks.map((t) => t.id));
      const allSelected = visible.length > 0 && visible.every((id) => prev.has(id));
      const next = new Set(prev);
      for (const id of visible) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, [filtered]);

  const toggleFolder = useCallback((folder: FolderNode) => {
    setSelected((prev) => {
      const ids = folder.tasks.map((t) => t.id);
      const allSelected = ids.every((id) => prev.has(id));
      const next = new Set(prev);
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const toggleExpandAll = useCallback(() => {
    setExpanded(allExpanded ? new Set() : new Set(allFolderIds));
  }, [allExpanded, allFolderIds]);

  return {
    folders: filtered,
    expanded,
    selected,
    allExpanded,
    allFolderIds,
    toggleExpand,
    toggleTask,
    toggleSelectAll,
    toggleFolder,
    clearSelection,
    toggleExpandAll,
    selectAllState,
    visibleTaskIds,
  };
}

/** Per-status task counts for the status menu rows. */
export function statusCountsOf(tasks: AgentTaskSummary[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    const key = taskFilterStatus(task);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
