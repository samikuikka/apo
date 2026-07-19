import { apiClient } from "./api-client";
import { isApiError } from "./api-error";

export interface GithubAvailability {
  enabled: boolean;
  client_id: string | null;
}

export interface GithubRepo {
  id: number;
  full_name: string;
  name: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
  pushed_at: string | null;
}

export interface GithubBranch {
  name: string;
  protected: boolean;
}

export interface GithubPathEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
}

export interface GithubConnection {
  project: string;
  github_username: string | null;
  github_user_id: string;
  scopes_granted: string | null;
  connected_at: string | null;
}

const NO_CACHE = { cache: "no-store" } as const;

export async function getGithubAvailability(
  projectId: string,
): Promise<GithubAvailability> {
  try {
    return await apiClient<GithubAvailability>(
      `/v1/projects/${encodeURIComponent(projectId)}/github/availability`,
      NO_CACHE,
    );
  } catch (error) {
    // 503 means the integration is not configured — surface as disabled
    // instead of throwing, so the form can render the manual URL fallback.
    if (isApiError(error) && error.status === 503) {
      return { enabled: false, client_id: null };
    }
    throw error;
  }
}

export const getGithubAuthUrl = (
  projectId: string,
  next?: string,
): Promise<{ url: string }> =>
  apiClient(
    `/v1/projects/${encodeURIComponent(projectId)}/github/auth-url`,
    { ...NO_CACHE, query: next ? { next } : undefined },
  );

export async function getGithubConnection(
  projectId: string,
): Promise<GithubConnection | null> {
  try {
    return await apiClient<GithubConnection>(
      `/v1/projects/${encodeURIComponent(projectId)}/github/connection`,
      NO_CACHE,
    );
  } catch (error) {
    // 503 = integration not configured → no connection.
    if (isApiError(error) && error.status === 503) return null;
    throw error;
  }
}

export const listGithubRepos = (projectId: string): Promise<GithubRepo[]> =>
  apiClient(
    `/v1/projects/${encodeURIComponent(projectId)}/github/repos`,
    NO_CACHE,
  );

export const listGithubBranches = (
  projectId: string,
  owner: string,
  repo: string,
): Promise<GithubBranch[]> =>
  apiClient(
    `/v1/projects/${encodeURIComponent(projectId)}/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
    NO_CACHE,
  );

export const listRepoContents = (
  projectId: string,
  owner: string,
  repo: string,
  ref: string,
  path: string,
): Promise<GithubPathEntry[]> =>
  apiClient(
    `/v1/projects/${encodeURIComponent(projectId)}/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`,
    { ...NO_CACHE, query: { ref, path } },
  );

export const disconnectGithub = (projectId: string): Promise<void> =>
  apiClient(
    `/v1/projects/${encodeURIComponent(projectId)}/github/connection`,
    { method: "DELETE" },
  );
