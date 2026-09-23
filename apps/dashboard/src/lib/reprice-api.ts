import { apiClient } from "./api-client";

/** Counts from `reprice_calls`; `net_delta` is the summed cost change in micro-USD. */
export interface RepriceSummary {
  repriced: number;
  skipped_provided: number;
  skipped_no_usage: number;
  skipped_no_match: number;
  net_delta: number;
  refreshed_runs: string[];
}

export interface RepriceJob {
  job_id: string;
  status: "running" | "done" | "error";
  summary: RepriceSummary | null;
  error: string | null;
  project: string | null;
}

/** Project owners/admins may reprice their own project; the backend enforces the role. */
export const startProjectReprice = (
  projectId: string,
  opts: { since?: string; dryRun: boolean },
): Promise<{ job_id: string }> =>
  apiClient("/v1/admin/reprice", {
    method: "POST",
    body: { project: projectId, since: opts.since || null, dry_run: opts.dryRun },
  });

export const getRepriceJob = (jobId: string, signal?: AbortSignal): Promise<RepriceJob> =>
  apiClient(`/v1/admin/reprice/${encodeURIComponent(jobId)}`, { signal });
