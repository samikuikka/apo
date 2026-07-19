import { apiClient } from "./api-client";
import type { ProjectRole } from "./projects-api";

export interface ProjectMemberSummary {
  user_id: string;
  email: string;
  name: string;
  role: ProjectRole;
  is_active: boolean;
  joined_at: string | null;
}

export interface AddProjectMemberRequest {
  email: string;
  role: "admin" | "member";
}

export interface UpdateProjectMemberRequest {
  role: ProjectRole;
}

const NO_CACHE = { cache: "no-store" } as const;

export const listProjectMembers = (
  projectId: string,
): Promise<ProjectMemberSummary[]> =>
  apiClient(`/v1/projects/${projectId}/members`, NO_CACHE);

export const updateProjectMemberRole = (
  projectId: string,
  userId: string,
  role: ProjectRole,
): Promise<ProjectMemberSummary> =>
  apiClient(`/v1/projects/${projectId}/members/${userId}`, {
    ...NO_CACHE,
    method: "PATCH",
    body: { role },
  });

export const removeProjectMember = (
  projectId: string,
  userId: string,
): Promise<void> =>
  apiClient(`/v1/projects/${projectId}/members/${userId}`, {
    ...NO_CACHE,
    method: "DELETE",
  });
