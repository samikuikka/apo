/**
 * Which run statuses are still moving, in one place.
 *
 * Task runs and batch runs have different live vocabularies: a task run
 * waiting to start is "pending" while a batch waiting to start is "queued",
 * and a settled batch ("completed", "partial", ...) is derived from its task
 * runs rather than being a task-run status at all. Before this module each
 * auto-refresh component and page hand-declared its own copy, so the sets
 * could silently drift apart.
 *
 * Statuses arrive from the API as plain strings (see WireStatus), so the
 * predicates accept strings. An unknown status reads as not-live and
 * not-terminal rather than being guessed at.
 */

/** Task-run statuses that end a run: a verdict or an execution error. */
export const TASK_RUN_TERMINAL_STATUSES: readonly string[] = ["passed", "failed", "error"];

/** Task-run statuses that are still moving toward a verdict. */
export const TASK_RUN_LIVE_STATUSES: readonly string[] = ["running", "pending"];

/** Batch-run statuses whose rows still change (and justify live updates). */
export const BATCH_RUN_LIVE_STATUSES: readonly string[] = ["running", "queued"];

// Mirrors TERMINAL_STATUSES in backend/apo/services/execution_leases.py.
export const TERMINAL_ATTEMPT_STATUSES: readonly string[] = [
  "succeeded",
  "failed",
  "cancelled",
  "lost",
];

export function isTaskRunLive(status: string): boolean {
  return TASK_RUN_LIVE_STATUSES.includes(status);
}

export function isTaskRunTerminal(status: string): boolean {
  return TASK_RUN_TERMINAL_STATUSES.includes(status);
}

export function isBatchRunLive(status: string): boolean {
  return BATCH_RUN_LIVE_STATUSES.includes(status);
}
