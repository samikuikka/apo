import { apiClient } from "./api-client";

export type ProjectRole = "owner" | "admin" | "member";

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
}

export type ProjectTaskSourceType = "git" | "filesystem" | "demo";

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

export interface ProjectTaskSourceFormData {
  source_type: ProjectTaskSourceType;
  display_name?: string;
  repository_url?: string;
  git_ref?: string;
  subpath?: string;
  filesystem_path?: string;
  demo_seed_id?: string;
}

export const listProjects = (): Promise<Project[]> =>
  apiClient("/v1/projects", { cache: "no-store" });

export const createProject = (name: string): Promise<ProjectDetail> =>
  apiClient("/v1/projects", { method: "POST", body: { name } });

export const getProject = (projectId: string): Promise<ProjectDetail> =>
  apiClient(`/v1/projects/${projectId}`, { cache: "no-store" });

export const updateProjectTaskSource = (
  projectId: string,
  body: ProjectTaskSourceFormData,
): Promise<ProjectTaskSource> =>
  apiClient(`/v1/projects/${projectId}/task-source`, {
    method: "PATCH",
    body,
  });

export const syncProjectTaskSource = (
  projectId: string,
): Promise<ProjectTaskSource> =>
  apiClient(`/v1/projects/${projectId}/task-source/sync`, {
    method: "POST",
  });
