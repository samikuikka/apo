// Client for the Tasks page "evidence views" endpoints (SPEC-174, Phase 1).
//
// A "view" is a model/effort filter over a project's runs. The Tasks page has a
// permanent Main view (no filter = all-history) plus closable derived tabs that
// narrow by model (+ model-aware effort). These helpers fetch the per-task
// stats scoped to the active view, and the project's run-configuration palette
// that populates the Model / Effort filter dropdowns.

import { apiClient } from "./api-client";
import type { AgentTaskRunDetail, AgentTaskRunStats } from "./agent-task-api";

const NO_CACHE = { cache: "no-store" } as const;

export interface RunConfigEffortFacet {
  effort: string;
  count: number;
}

export interface RunConfigModelFacet {
  model: string;
  count: number;
  efforts: RunConfigEffortFacet[];
}

/**
 * Per-task run stats scoped to a model/effort view.
 *
 * Omit both `model` and `effort` for Main (all-history, identical to the
 * `run_stats` already attached by `listProjectAgentTasks`). With a `model` the
 * cohort narrows to that model; `effort` further narrows within it. Tasks with
 * no matching runs are absent from the returned map (treated as no-run by the
 * caller).
 */
export const fetchTaskViewStats = (
  projectId: string,
  model?: string | null,
  effort?: string | null,
  since?: string | null,
  signal?: AbortSignal,
): Promise<Record<string, AgentTaskRunStats>> =>
  apiClient(`/v1/projects/${encodeURIComponent(projectId)}/agent-task-run-stats`, {
    ...NO_CACHE,
    query: { model: model ?? undefined, effort: effort ?? undefined, since: since ?? undefined },
    signal,
  });

/**
 * Distinct (model, effort) run configurations in the project — the palette for
 * the Model dropdown and, once a model is picked, that model's effort tiers.
 * Legacy runs with no `configured_model` are excluded server-side.
 */
export const fetchTaskViewConfigFacets = (
  projectId: string,
): Promise<RunConfigModelFacet[]> =>
  apiClient(`/v1/projects/${encodeURIComponent(projectId)}/agent-task-run-config-facets`, NO_CACHE);

// ----------------------------------------------------------------------------
// SPEC-174 Phase 2 — selection-scoped view comparison (immutable snapshot)
// ----------------------------------------------------------------------------

export interface TaskViewConfig {
  model: string | null;  // null = All models (Main)
  effort: string | null; // null = any effort
  since: string | null;  // "7d" | "30d" | "90d" | null (all time)
}

export interface ResolvedComparisonCell {
  task_id: string;
  a_run_id: string | null;
  b_run_id: string | null;
  a_status: string | null;  // passed | failed | error | null (not run)
  b_status: string | null;
  comparable: boolean;
}

export interface TaskViewComparisonSnapshot {
  id: string;
  project_id: string;
  view_a_config: TaskViewConfig;
  view_b_config: TaskViewConfig;
  task_ids: string[];
  resolved: ResolvedComparisonCell[];
  coverage: { both_run: number; comparable: number; scope: number };
  created_at: string;
  created_by: string | null;
}

export interface TaskViewComparisonEvidence {
  snapshot: TaskViewComparisonSnapshot;
  runs: AgentTaskRunDetail[];
}

/**
 * Create an immutable, selection-scoped comparison snapshot. The server resolves
 * the latest run per task under each view, freezes run ids + revisions +
 * coverage, and returns the snapshot (including its short opaque id — the only
 * thing that goes in the shareable URL).
 */
export const createTaskViewComparison = (
  projectId: string,
  body: { task_ids: string[]; view_a: TaskViewConfig; view_b: TaskViewConfig },
): Promise<TaskViewComparisonSnapshot> =>
  apiClient(`/v1/projects/${encodeURIComponent(projectId)}/task-view-comparisons`, {
    method: "POST",
    body,
  });

/** Read a snapshot by id (shareable, reload-stable). Scoped to its project. */
export const getTaskViewComparison = (
  projectId: string,
  comparisonId: string,
): Promise<TaskViewComparisonSnapshot> =>
  apiClient(
    `/v1/projects/${encodeURIComponent(projectId)}/task-view-comparisons/${encodeURIComponent(comparisonId)}`,
    NO_CACHE,
  );

/** Read the frozen snapshot and every resolved run's evidence in one request. */
export const getTaskViewComparisonEvidence = (
  projectId: string,
  comparisonId: string,
): Promise<TaskViewComparisonEvidence> =>
  apiClient(
    `/v1/projects/${encodeURIComponent(projectId)}/task-view-comparisons/${encodeURIComponent(comparisonId)}/evidence`,
    NO_CACHE,
  );

// ----------------------------------------------------------------------------
// Saved evidence views (persistent tabs — SPEC-174)
// ----------------------------------------------------------------------------

export interface SavedView {
  id: string;
  label: string;
  model: string | null;
  effort: string | null;
  since: string | null;
}

/** List the caller's saved evidence-view tabs for the project. */
export const fetchSavedViews = (projectId: string): Promise<SavedView[]> =>
  apiClient(`/v1/projects/${encodeURIComponent(projectId)}/task-views`, NO_CACHE);

/** Create a saved evidence-view tab. Returns the persisted view with its id. */
export const createSavedView = (
  projectId: string,
  body: { label: string; model: string | null; effort: string | null; since: string | null },
): Promise<SavedView> =>
  apiClient(`/v1/projects/${encodeURIComponent(projectId)}/task-views`, { method: "POST", body });

/** Update supplied fields on a saved view; explicit null clears nullable filters. */
export const updateSavedView = (
  projectId: string,
  viewId: string,
  body: { label?: string; model?: string | null; effort?: string | null; since?: string | null },
): Promise<SavedView> =>
  apiClient(`/v1/projects/${encodeURIComponent(projectId)}/task-views/${encodeURIComponent(viewId)}`, {
    method: "PATCH",
    body,
  });

/** Delete a saved evidence-view tab. */
export const deleteSavedView = (projectId: string, viewId: string): Promise<void> =>
  apiClient(`/v1/projects/${encodeURIComponent(projectId)}/task-views/${encodeURIComponent(viewId)}`, {
    method: "DELETE",
  });
