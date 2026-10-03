"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import type {
  AgentTaskRunStats,
  AgentTaskSummary,
} from "@/lib/agent-task-api";
import {
  createSavedView,
  deleteSavedView,
  fetchSavedViews,
  fetchTaskViewConfigFacets,
  fetchTaskViewStats,
  type RunConfigModelFacet,
  setModelArchived,
  updateSavedView,
} from "@/lib/agent-task-view-api";

import { MAIN_VIEW_ID, type ViewTab } from "./task-list-shared";

/**
 * Evidence views state, extracted from AgentTasksClient.
 *
 * Owns the tab strip (a permanent "Main" tab showing all-history plus
 * closable derived tabs narrowed by model / model-aware effort / date), the
 * model-effort palette, the per-view scoped stats overlays, and the tab
 * operations (update / duplicate / close), which auto-persist server-side.
 * The task table renders against `effectiveTasks`: original tasks for Main,
 * or the same tasks with view-scoped stats overlaid for a derived tab.
 */
export function useEvidenceViews({
  projectId,
  isDemoProject,
  tasks,
  initialViewId = null,
}: {
  projectId: string;
  isDemoProject: boolean;
  tasks: AgentTaskSummary[];
  /** `?view=` from the URL: re-select that tab on arrival. */
  initialViewId?: string | null;
}) {
  // ---- Evidence views: a permanent "Main" tab (all-history) plus
  // closable derived tabs narrowed by model (+ model-aware effort). The stats
  // shown in the task table are scoped to the active tab's cohort.
  const [views, setViews] = useState<ViewTab[]>([{ id: MAIN_VIEW_ID, label: "Main", model: null, effort: null, since: null, provider: null }]);
  const [activeViewId, setActiveViewId] = useState<string>(initialViewId ?? MAIN_VIEW_ID);
  const [facets, setFacets] = useState<RunConfigModelFacet[]>([]);
  // Per-view stats overlays keyed by the view's filter content, so switching
  // tabs shows cached stats instantly and never flashes another view's data.
  // null = Main (use the all-history run_stats already attached to each task
  // by the server).
  const [statsByView, setStatsByView] = useState<Record<string, Record<string, AgentTaskRunStats> | null>>({});
  const [addingTab, setAddingTab] = useState(false);
  const activeView = views.find((v) => v.id === activeViewId) ?? views[0]!;

  // Load the model/effort palette + the user's saved views on mount.
  useEffect(() => {
    if (isDemoProject) return;
    let cancelled = false;
    fetchTaskViewConfigFacets(projectId)
      .then((f) => { if (!cancelled) setFacets(f); })
      .catch(() => { /* palette is best-effort; filters just stay empty */ });
    fetchSavedViews(projectId)
      .then((saved) => {
        if (cancelled) return;
        const loaded = [
          { id: MAIN_VIEW_ID, label: "Main", model: null, effort: null, since: null, provider: null },
          ...saved.map((v) => ({
            id: v.id,
            label: v.label,
            model: v.model,
            effort: v.effort,
            since: v.since,
            provider: v.provider ?? null,
          })),
        ];
        setViews(loaded);
        // A ?view= that no longer exists (deleted view, stale bookmark) falls
        // back to Main instead of highlighting a ghost tab.
        if (initialViewId && !loaded.some((v) => v.id === initialViewId)) {
          setActiveViewId(MAIN_VIEW_ID);
        }
      })
      .catch(() => { /* saved views are best-effort; fall back to Main only */ });
    return () => { cancelled = true; };
  }, [projectId, isDemoProject, initialViewId]);

  // When the active tab is a derived view, fetch its scoped stats and overlay
  // them. Main reuses the server-provided all-history stats (viewStats = null).
  const viewIsDerived =
    activeView.model !== null ||
    activeView.effort !== null ||
    activeView.since !== null ||
    activeView.provider !== null;
  const viewStatsKey = `${activeView.model ?? ""}|${activeView.effort ?? ""}|${activeView.since ?? ""}|${activeView.provider ?? ""}`;
  useEffect(() => {
    if (isDemoProject || !viewIsDerived) return;
    const key = viewStatsKey;
    const controller = new AbortController();
    fetchTaskViewStats(
      projectId,
      activeView.model,
      activeView.effort,
      activeView.since,
      controller.signal,
      activeView.provider,
    )
      .then((stats) => {
        if (controller.signal.aborted) return;
        setStatsByView((prev) => ({ ...prev, [key]: stats }));
      })
      .catch(() => {
        // Keep any previously loaded overlay for this view on transient
        // failure; fall back to the server-provided stats when none exists.
        if (controller.signal.aborted) return;
        setStatsByView((prev) => (key in prev ? prev : { ...prev, [key]: null }));
      });
    return () => controller.abort();
    // `tasks` changes identity only when the server page re-runs (refresh or
    // resync), which is when the derived overlay must be refetched too.
  }, [projectId, activeView.model, activeView.effort, activeView.since, activeView.provider, isDemoProject, viewIsDerived, viewStatsKey, tasks]);

  // Derived per active tab: no effect-time syncing, so a tab switch never
  // renders one frame with the previous view's overlay still applied.
  const viewStats = viewIsDerived && !isDemoProject ? (statsByView[viewStatsKey] ?? null) : null;
  const viewStatsLoading = viewIsDerived && !isDemoProject && !(viewStatsKey in statsByView);

  // The task table renders against this: original tasks for Main, or the same
  // tasks with view-scoped stats overlaid for a derived tab (tasks with no run
  // under the view get null stats → render as "Ready to run").
  const effectiveTasks = useMemo<AgentTaskSummary[]>(() => {
    if (!viewStats) return tasks;
    return tasks.map((t) => ({ ...t, run_stats: viewStats[t.id] ?? null }));
  }, [tasks, viewStats]);

  // ---- Evidence view tab operations (auto-persisted server-side) ----
  const updateActiveView = (
    patch: Partial<Pick<ViewTab, "model" | "effort" | "since" | "provider" | "label">>,
  ) => {
    setViews((prev) => prev.map((v) => (v.id === activeViewId ? { ...v, ...patch } : v)));
    // Persist to server (best-effort). Main is never stored.
    if (activeViewId !== MAIN_VIEW_ID && !isDemoProject) {
      updateSavedView(projectId, activeViewId, patch).catch(() => {});
    }
  };
  const duplicateActive = async () => {
    if (isDemoProject || addingTab) return;
    setAddingTab(true);
    try {
      const saved = await createSavedView(projectId, {
        label: `View ${views.length}`,
        model: activeView.model,
        effort: activeView.effort,
        since: activeView.since,
        provider: activeView.provider,
      });
      setViews((prev) => [
        ...prev,
        {
          id: saved.id,
          label: saved.label,
          model: saved.model,
          effort: saved.effort,
          since: saved.since,
          provider: saved.provider ?? null,
        },
      ]);
      setActiveViewId(saved.id);
    } catch {
      toast.error("Failed to save view");
    } finally {
      setAddingTab(false);
    }
  };
  const closeView = (id: string) => {
    if (id === MAIN_VIEW_ID) return;
    setViews((prev) => prev.filter((v) => v.id !== id));
    if (activeViewId === id) setActiveViewId(MAIN_VIEW_ID);
    if (!isDemoProject) deleteSavedView(projectId, id).catch(() => {});
  };

  // Archiving retires a model from the filter dropdowns project-wide. The
  // palette is fetched client-side here, so the local copy is patched rather
  // than refetched (the Runs page renders its facets server-side and refreshes).
  const setModelArchivedState = async (model: string, archived: boolean) => {
    const previous = facets;
    setFacets((prev) => prev.map((f) => (f.model === model ? { ...f, archived } : f)));
    try {
      await setModelArchived(projectId, model, archived);
      toast.success(archived ? "Model archived" : "Model restored");
    } catch (e: unknown) {
      setFacets(previous);
      toast.error(e instanceof Error ? e.message : "Failed to update model");
    }
  };

  return {
    views,
    activeView,
    activeViewId,
    setActiveViewId,
    facets,
    addingTab,
    viewStatsLoading,
    effectiveTasks,
    updateActiveView,
    duplicateActive,
    closeView,
    setModelArchivedState,
  };
}
