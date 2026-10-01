/**
 * Remote trace projection reader.
 *
 * Polls the Task-Run-scoped projection endpoint
 * (`GET /v1/agent-task-runs/{task_run_id}/trace-projection`) with bounded
 * exponential backoff until the projection is ready, then returns the immutable
 * snapshot Phase 2 evaluation reads.
 *
 * This is the canonical capture path for backend-launched required-persistence
 * runs: after the OTel exporter force-flushes, the runner polls its own
 * projection endpoint to read back the durable, projected trace — the same one
 * the dashboard shows.
 */

import type { TraceProjectionSnapshot } from "./types.ts";

/** Configuration for the projection read retry loop. */
export interface ProjectionReadOptions {
  /** The backend base URL, e.g. ``"http://localhost:8000"``. */
  endpoint: string;
  /** The service token (Authorization: Bearer …). */
  authToken: string;
  /** The task run ID whose projection to read. */
  taskRunId: string;
  /** Maximum total wait time in milliseconds (default: 30000). */
  deadlineMs?: number;
  /** Initial retry interval in milliseconds (default: 500). */
  initialIntervalMs?: number;
  /** Maximum retry interval after backoff (default: 5000). */
  maxIntervalMs?: number;
  /**
   * Retry 409 "Task run has no trace" like a 202. Set for fresh-run readback,
   * where the run row was pre-created and subprocess-exported spans are still
   * in flight; leave unset for settled reads (rejudge of a completed run),
   * where a missing trace is a permanent fact of that run.
   */
  retryNoTrace?: boolean;
}

/** Error thrown when the projection is not ready within the deadline. */
export class ProjectionTimeoutError extends Error {
  constructor(taskRunId: string, deadlineMs: number) {
    super(
      `Trace projection for task run ${taskRunId} was not ready within ${deadlineMs}ms`,
    );
    this.name = "ProjectionTimeoutError";
  }
}

/**
 * Read the projection snapshot for a task run, retrying with bounded
 * exponential backoff until it's ready (200) or the deadline expires.
 *
 * Throws {@link ProjectionTimeoutError} on timeout. Throws on 403/404/409
 * (the endpoint's permanent-error responses) — except that 409 "no trace
 * yet" is retried when {@link ProjectionReadOptions.retryNoTrace} is set for
 * fresh-run readback, where the claim lands asynchronously.
 */
export async function readTaskRunProjection(
  options: ProjectionReadOptions,
): Promise<TraceProjectionSnapshot> {
  const deadlineMs = options.deadlineMs ?? 30_000;
  const initialIntervalMs = options.initialIntervalMs ?? 500;
  const maxIntervalMs = options.maxIntervalMs ?? 5_000;

  const url = `${options.endpoint.replace(/\/$/, "")}/v1/agent-task-runs/${encodeURIComponent(options.taskRunId)}/trace-projection`;
  const start = Date.now();
  let interval = initialIntervalMs;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - start > deadlineMs) {
      throw new ProjectionTimeoutError(options.taskRunId, deadlineMs);
    }

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${options.authToken}` },
    });

    if (response.status === 200) {
      return (await response.json()) as TraceProjectionSnapshot;
    }

    if (response.status === 202 || (response.status === 409 && options.retryNoTrace)) {
      // 202: projection not ready yet. 409 "Task run has no trace" with
      // retryNoTrace: the run row was pre-created (caller/executor flow) and
      // the trace has not been claimed by ingestion yet — transient while
      // subprocess-exported spans are still in flight, so it backs off and
      // retries like a 202 until the deadline (then the caller falls back to
      // the local snapshot).
      await sleep(interval);
      interval = Math.min(interval * 1.5, maxIntervalMs);
      continue;
    }

    // 403/404 — permanent errors, surface immediately.
    const detail = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(
      `Projection read failed (${response.status}): ${(detail as { detail?: string }).detail ?? response.statusText}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
