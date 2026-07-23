/**
 * Resolve an agent-task-run id from a user-provided input: a full id, a unique
 * prefix, or the literal `"last"` (latest run, optionally scoped to a task).
 * Shared by `runs show` and `runs deliverable` so prefix/`last` resolution is
 * consistent across commands.
 */
import type { resolveConfig } from "../lib/config.ts";
import { apiGet } from "./api.ts";
import { findByPrefix } from "./prefix.ts";

type ResolvedConfig = ReturnType<typeof resolveConfig>;

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
  if (input.length < 32) {
    return resolveRunIdByPrefix(backendUrl, input, config);
  }
  return input;
}

export async function resolveRunIdByPrefix(
  backendUrl: string,
  prefix: string,
  config: ResolvedConfig,
): Promise<string> {
  const params: Record<string, string> = {};
  if (config.projectId) params.project = config.projectId;

  const runs = await apiGet<Array<{ id: string }>>(
    backendUrl,
    "/v1/agent-task-runs",
    params,
    config,
  );
  const result = findByPrefix(runs, prefix, (r) => r.id);
  if (result.status === "none") {
    throw new Error(`Backend error 404: {"detail":"Run not found"}`);
  }
  if (result.status === "ambiguous") {
    throw new Error(
      `Run ID prefix "${prefix}" matches multiple runs: ${result.items
        .map((r) => r.id)
        .join(", ")}`,
    );
  }
  return result.item.id;
}

export async function resolveLatestRunId(
  backendUrl: string,
  config: ResolvedConfig,
  taskFilter?: string,
): Promise<string> {
  const params: Record<string, string> = { limit: "1" };
  if (config.projectId) params.project = config.projectId;
  if (taskFilter) params.task_id = taskFilter;

  const runs = await apiGet<Array<{ id: string }>>(
    backendUrl,
    "/v1/agent-task-runs",
    params,
    config,
  );
  if (runs.length === 0) {
    throw new Error("NO_RUNS");
  }
  return runs[0].id;
}
