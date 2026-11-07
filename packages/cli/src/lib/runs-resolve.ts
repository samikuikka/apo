/**
 * Resolve an agent-task-run id from a user-provided input: a full id, a unique
 * prefix, or the literal `"last"` (latest run, optionally scoped to a task).
 * Shared by `runs show` and `runs deliverable` so prefix/`last` resolution is
 * consistent across commands.
 */
import type { resolveConfig } from "../lib/config.ts";
import { apiGet } from "./api.ts";
import { isRunLive } from "./run-status.ts";
import {
  findByPrefix,
  formatCandidates,
  isCanonicalRunId,
  UnresolvedIdError,
} from "./prefix.ts";

type ResolvedConfig = ReturnType<typeof resolveConfig>;

/**
 * A complete run id, usable verbatim — a canonical id (`run_` + 24 hex) or a
 * legacy pre-canonical id (32+ chars). Anything else may be a prefix and is
 * matched against the run list. Length alone can't decide this: canonical ids
 * are 28 chars, so the old `< 32 means prefix` rule sent every full id
 * through prefix matching, which only sees the backend's default listing
 * window (the 1000 most recent runs) and failed for older runs.
 */
export function isFullRunId(input: string): boolean {
  return isCanonicalRunId(input) || input.length >= 32;
}

/** Resolve `input` (full id | prefix | "last") to a concrete run id. */
export async function resolveRunId(
  backendUrl: string,
  input: string,
  config: ResolvedConfig,
  taskFilter?: string,
): Promise<string> {
  if (!input || input === "last") {
    return resolveLatestRunId(backendUrl, config, taskFilter);
  }
  if (!isFullRunId(input)) {
    return resolveRunIdByPrefix(backendUrl, input, config);
  }
  return input;
}

export async function resolveRunIdByPrefix(
  backendUrl: string,
  prefix: string,
  config: ResolvedConfig,
): Promise<string> {
  // `id_prefix` filters server-side; a backend from before it ignores the
  // parameter and returns its newest runs, so the match also runs here.
  const params: Record<string, string> = { id_prefix: prefix };
  if (config.projectId) params.project = config.projectId;

  const runs = await apiGet<Array<{ id: string }>>(
    backendUrl,
    "/v1/agent-task-runs",
    params,
    config,
  );
  const result = findByPrefix(runs, prefix, (r) => r.id);
  if (result.status === "none") {
    const scope = config.projectId ? ` in project ${config.projectId}` : "";
    throw new UnresolvedIdError(
      `No run id starts with "${prefix}"${scope}. Check the id, or use the full run id ` +
        `(a backend older than id-prefix search only looks at its 1000 most ` +
        `recent runs).`,
    );
  }
  if (result.status === "ambiguous") {
    throw new Error(
      `Run ID prefix "${prefix}" matches multiple runs: ${formatCandidates(
        result.items.map((r) => r.id),
      )}`,
    );
  }
  return result.item.id;
}

/**
 * The latest run, skipping runs that ended without starting (expired before an
 * executor claimed them), which the run list puts first. A queued run is still
 * the latest. A backend that predates `exclude_not_started` ignores it, and the
 * small page is filtered here instead.
 */
export async function resolveLatestRunId(
  backendUrl: string,
  config: ResolvedConfig,
  taskFilter?: string,
): Promise<string> {
  const params: Record<string, string> = { limit: "20", exclude_not_started: "true" };
  if (config.projectId) params.project = config.projectId;
  if (taskFilter) params.task_id = taskFilter;

  const runs = await apiGet<Array<{ id: string; started_at?: string | null; status?: string }>>(
    backendUrl,
    "/v1/agent-task-runs",
    params,
    config,
  );
  if (runs.length === 0) {
    throw new Error("NO_RUNS");
  }
  const latest = runs.find(
    (r) => r.started_at || (r.status !== undefined && isRunLive(r.status)),
  );
  return (latest ?? runs[0]).id;
}
