"use client";

// PROTOTYPE (throwaway) — variant `cur`: today's production EvidenceViewsBar,
// rendered with prototype-local state so the owner can compare it side by
// side with the alternatives without juggling checkouts. Read-only: tab ops
// mutate local state only; archiving is disabled.

import { useEffect, useMemo, useState } from "react";

import { fetchTaskHostFacets } from "@/lib/agent-task-view-api";

import { EvidenceViewsBar } from "../EvidenceViewsBar";
import { FolderList } from "../FolderList";
import { type ViewTab } from "../task-list-shared";
import {
  cohortIsEmpty,
  cohortKey,
  statusCountsOf,
  useFolderView,
  useViewsProtoState,
  type VariantProps,
} from "./proto-state";
import { applyStats, useCohortStats } from "./use-cohort-stats";

export function VariantBaseline({ projectId, tasks, facets, seedViews }: VariantProps) {
  const state = useViewsProtoState(seedViews);
  const { cohort } = state;
  const { statsByKey, loading } = useCohortStats(projectId, [cohort]);
  const scopedTasks = useMemo(
    () => applyStats(tasks, cohortIsEmpty(cohort) ? undefined : statsByKey[cohortKey(cohort)]),
    [tasks, cohort, statsByKey],
  );
  const fv = useFolderView(scopedTasks, state);
  const statusCounts = useMemo(() => statusCountsOf(scopedTasks), [scopedTasks]);

  // Host palette for the current model, mirroring the production fetch.
  const [hostFacets, setHostFacets] = useState<{ label: string; count: number }[]>([]);
  useEffect(() => {
    if (!cohort.model) {
      setHostFacets([]);
      return;
    }
    const controller = new AbortController();
    fetchTaskHostFacets(projectId, controller.signal, cohort.model)
      .then((f) => setHostFacets(f))
      .catch(() => {});
    return () => controller.abort();
  }, [projectId, cohort.model]);

  const views: ViewTab[] = state.views.map((v) => ({
    id: v.id,
    label: v.label,
    model: v.cohort.model,
    effort: v.cohort.effort,
    since: v.cohort.since,
    provider: v.cohort.provider,
  }));

  return (
    <>
      <EvidenceViewsBar
        views={views}
        activeViewId={state.activeId}
        facets={facets}
        hostFacets={hostFacets}
        loading={loading}
        isDerived={!cohortIsEmpty(cohort)}
        viewsActive
        addingTab={false}
        statusCounts={statusCounts}
        query={state.query}
        onQueryChange={state.setQuery}
        selectedCount={fv.selected.size}
        onClearSelection={fv.clearSelection}
        onToggleExpandAll={fv.toggleExpandAll}
        allExpanded={fv.allExpanded}
        status={state.statusFilter}
        onStatusChange={state.setStatusFilter}
        onSelect={state.setActiveId}
        onChange={(patch) => {
          if (patch.label !== undefined) state.renameActive(patch.label);
          const { label: _label, ...cohortPatch } = patch;
          state.setCohort(cohortPatch);
        }}
        onSetArchived={() => {}}
        onDuplicate={() => state.saveAsNew(`View ${state.views.length}`)}
        onClose={state.removeView}
      />
      <FolderList
        folders={fv.folders}
        expanded={fv.expanded}
        selected={fv.selected}
        query={state.query}
        selectAllState={fv.selectAllState}
        visibleTaskCount={fv.visibleTaskIds.length}
        onToggleSelectAll={fv.toggleSelectAll}
        onToggleFolder={fv.toggleFolder}
        onToggleTask={fv.toggleTask}
        onToggleExpand={fv.toggleExpand}
      />
    </>
  );
}
