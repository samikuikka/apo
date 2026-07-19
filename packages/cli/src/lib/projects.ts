import { apiGet } from "./api.ts";
import { resolveConfig } from "./config.ts";
import { findByPrefix, type PrefixResolveResult } from "./prefix.ts";

export type ProjectSummary = {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  current_user_role: string | null;
};

/** Fetch the projects the current user can access (requires a saved key). */
export async function fetchProjects(flags: Record<string, string | boolean>) {
  const config = resolveConfig(flags);
  const projects = await apiGet<ProjectSummary[]>(
    config.backendUrl,
    "/v1/projects",
    undefined,
    config,
  );
  return { config, projects };
}

/**
 * Resolve a user-provided target to a single project. Accepts an exact id,
 * an exact name, or a unique leading id prefix (jj/git-style). Returns
 * "ambiguous"/"none" so the caller can surface a helpful message.
 */
export function resolveProject<T extends { id: string; name: string }>(
  projects: T[],
  target: string,
): PrefixResolveResult<T> {
  const byId = projects.find((p) => p.id === target);
  if (byId) return { status: "unique", item: byId };
  const byName = projects.find((p) => p.name === target);
  if (byName) return { status: "unique", item: byName };
  return findByPrefix(projects, target, (p) => p.id);
}

