import { apiClient } from "./api-client";

export type ProjectRole = "owner" | "admin" | "member" | "viewer";

export interface ProjectPermissionSummary {
  role: ProjectRole | null;
  can_manage_project: boolean;
  can_manage_members: boolean;
  can_run_tasks: boolean;
  can_edit_scores: boolean;
}

export interface Project {
  id: string;
  name: string;
  created_by: string;
  created_at: string | null;
  current_user_role: ProjectRole | null;
  /** Per-project evidence-retention override: null = inherit env default, 0 = forever.
   *  Optional for tolerance of older backends that predate the field. */
  evidence_retention_days?: number | null;
  /** What maintenance actually uses for this project (override, else env default). */
  effective_evidence_retention_days?: number;
}

export type ProjectTaskSourceType = "git" | "filesystem" | "demo" | "published";

export type ProjectTaskSourceStatus =
  | "unconfigured"
  | "pending_sync"
  | "syncing"
  | "ready"
  | "error";

export interface ProjectTaskSource {
  project: string;
  source_type: ProjectTaskSourceType;
  display_name: string;
  repository_url: string | null;
  git_ref: string | null;
  subpath: string | null;
  filesystem_path: string | null;
  demo_seed_id: string | null;
  status: ProjectTaskSourceStatus;
  last_synced_at: string | null;
  last_resolved_commit_sha: string | null;
  last_error: string | null;
  inventory_stale: boolean;
}

export interface ProjectDetail extends Project {
  permissions: ProjectPermissionSummary | null;
  task_source: ProjectTaskSource | null;
}

export const listProjects = (signal?: AbortSignal): Promise<Project[]> =>
  apiClient("/v1/projects", { cache: "no-store", signal });

export const createProject = (name: string): Promise<ProjectDetail> =>
  apiClient("/v1/projects", { method: "POST", body: { name } });

export const getProject = (
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectDetail> =>
  apiClient(`/v1/projects/${projectId}`, { cache: "no-store", signal });

/** Tri-state: null = inherit the env default, 0 = keep evidence forever, N = days. */
export const updateProjectEvidenceRetention = (
  projectId: string,
  days: number | null,
): Promise<ProjectDetail> =>
  apiClient(`/v1/projects/${projectId}`, {
    method: "PATCH",
    body: { evidence_retention_days: days },
  });

export const syncProjectTaskSource = (
  projectId: string,
): Promise<ProjectTaskSource> =>
  apiClient(`/v1/projects/${projectId}/task-source/sync`, {
    method: "POST",
  });

/** Bounded first-run signal: scalar progress counts + public origin. */
export interface ProjectOnboardingStatus {
  published_task_count: number;
  recorded_run_count: number;
  public_url: string | null;
}

export const getProjectOnboardingStatus = (
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectOnboardingStatus> =>
  apiClient(`/v1/projects/${projectId}/onboarding-status`, {
    cache: "no-store",
    signal,
  });
