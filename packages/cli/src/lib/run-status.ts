/**
 * The run/batch status vocabulary, centralized: liveness, terminality, and
 * the verdict-to-exit-code contract live here so commands never re-derive
 * them from loose string literals. The unions mirror the backend's
 * canonical lifecycles (its projection rejects any value outside them, so
 * clients may treat them as closed).
 */
export type AgentTaskRunStatus = "pending" | "running" | "passed" | "failed" | "error";

export type AgentTaskBatchRunStatus = "queued" | "running" | "completed" | "error";

/** A run that has not reached a verdict yet. */
export const RUN_LIVE_STATUSES: ReadonlySet<string> = new Set(["pending", "running"]);

/** A batch that may still change; watch loops keep polling while this holds. */
export const BATCH_LIVE_STATUSES: ReadonlySet<string> = new Set(["queued", "running"]);

/** Statuses that carry a PASS/FAIL verdict. */
export const VERDICT_TERMINAL_STATUSES: ReadonlySet<string> = new Set(["passed", "failed"]);

/** Every status a run ends in; `error` carries no verdict. */
export const RUN_TERMINAL_STATUSES: ReadonlySet<string> = new Set(["passed", "failed", "error"]);

/** Type guards, so a check doubles as narrowing at the call site. */
export function isRunLive(status: string): status is "pending" | "running" {
  return RUN_LIVE_STATUSES.has(status);
}

export function isBatchLive(status: string): status is "queued" | "running" {
  return BATCH_LIVE_STATUSES.has(status);
}

export function isVerdictTerminal(status: string): status is "passed" | "failed" {
  return VERDICT_TERMINAL_STATUSES.has(status);
}

export function isRunTerminal(status: string): status is "passed" | "failed" | "error" {
  return RUN_TERMINAL_STATUSES.has(status);
}

/**
 * The exit-code contract for a verdict, defined once: 0 passed, 1 failed,
 * 2 error or no verdict (a judge that never answered is not the agent
 * failing, issue #323).
 */
export function verdictExitCode(status: string): 0 | 1 | 2 {
  if (status === "passed") return 0;
  if (status === "failed") return 1;
  return 2;
}

/**
 * A locally computed verdict as the status `verdictExitCode` reads. A
 * no-verdict outranks a pass here, exactly as the boolean helper it
 * replaced: an SDK can stamp `noVerdict` on a run whose checks it also
 * marked passing, and the safe exit code is still 2.
 */
export function localVerdictStatus(passed: boolean, noVerdict: boolean): AgentTaskRunStatus {
  if (noVerdict) return "error";
  return passed ? "passed" : "failed";
}
