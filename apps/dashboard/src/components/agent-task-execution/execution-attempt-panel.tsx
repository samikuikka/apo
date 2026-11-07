import { Clock, Cpu, Server } from "lucide-react";
import type {
  AttemptWaitingReason,
  ExecutionAttemptSummary,
} from "@/lib/agent-task-api";
import { TERMINAL_ATTEMPT_STATUSES } from "@/lib/run-liveness";

interface ExecutionAttemptPanelProps {
  attempts: ExecutionAttemptSummary[];
  poolName: string | null;
}

export function ExecutionAttemptPanel({
  attempts,
  poolName,
}: ExecutionAttemptPanelProps) {
  if (!hasDiagnosticValue(attempts)) return null;

  const visibleAttempts = attempts.toSorted(
    (left, right) =>
      new Date(right.queued_at).getTime() - new Date(left.queued_at).getTime(),
  );

  return (
    <section
      className="border-t border-border px-6 py-4"
      aria-labelledby="execution-attempts-heading"
    >
      <div className="mb-3 flex items-center gap-2">
        <Server className="h-3.5 w-3.5 text-muted-foreground" />
        <h2
          id="execution-attempts-heading"
          className="text-[12px] font-medium uppercase tracking-wider"
        >
          Execution
        </h2>
        <span className="font-mono text-[11px] text-muted-foreground">
          {visibleAttempts.length} attempt{visibleAttempts.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="divide-y divide-border border border-border">
        {visibleAttempts.map((attempt) => {
          const isSourceOwned = attempt.assignment_kind === "source_owned";
          const presentation = isSourceOwned
            ? describeSourceOwnedAttempt(attempt)
            : describePoolAttempt(attempt, poolName);
          return (
            <div
              key={attempt.id}
              className="grid gap-2 px-3 py-2.5 sm:grid-cols-[1fr_auto]"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[12px]">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${presentation.dot}`}
                    aria-hidden
                  />
                  <span className="font-medium">{presentation.title}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {attempt.task_run_id.slice(0, 8)}
                  </span>
                </div>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  {presentation.detail}
                </p>
                {presentation.guidance && (
                  <p className="mt-0.5 text-[12px] text-muted-foreground/70">
                    {presentation.guidance}
                  </p>
                )}
                {attempt.error_message && !presentation.guidance && (
                  <p className="mt-1 line-clamp-2 text-[11px] text-destructive">
                    {attempt.error_message}
                  </p>
                )}
              </div>
              <div className="flex items-start gap-3 text-[11px] text-muted-foreground">
                {/* source-owned Runs never expose driver/machine. */}
                {!isSourceOwned && attempt.driver_kind && (
                  <span className="inline-flex items-center gap-1">
                    <Cpu className="h-3 w-3" />
                    {attempt.driver_kind}
                  </span>
                )}
                <span className="inline-flex items-center gap-1 font-mono">
                  <Clock className="h-3 w-3" />
                  {formatAttemptTime(attempt)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

type Presentation = {
  title: string;
  detail: string;
  guidance: string | null;
  dot: string;
};

/**
 * The panel renders only when it is the sole source of some fact: a live
 * attempt's waiting reason, phase, or heartbeat, or retry history. Attempts
 * are per Task Run (one each even without retries — see
 * execution_queue.py), so retries mean more attempts than distinct Task
 * Runs. An all-terminal batch adds nothing: the page header already shows
 * the outcome and the task-run table shows error messages inline.
 */
function hasDiagnosticValue(attempts: ExecutionAttemptSummary[]): boolean {
  if (attempts.length === 0) return false;
  if (attempts.some((a) => !TERMINAL_ATTEMPT_STATUSES.includes(a.status))) return true;
  return new Set(attempts.map((a) => a.task_run_id)).size < attempts.length;
}

// ============================================================================
// Source-owned presentation
// ============================================================================

/** Stable copy for a queued source-owned Attempt's dynamic waiting reason. */
function waitingCopy(reason: AttemptWaitingReason): {
  detail: string;
  guidance: string | null;
} {
  switch (reason) {
    case "ready":
      return { detail: "Your connected environment is ready.", guidance: null };
    case "busy":
      return {
        detail: "Your connected environment is busy — this run will wait.",
        guidance: null,
      };
    case "offline":
      return {
        detail: "Waiting for apo connect.",
        guidance: "Start apo connect in this Task workspace.",
      };
    case "not_connected":
      return {
        detail: "Run apo connect in this Task workspace.",
        guidance: "Authenticate and connect this Project.",
      };
    case "incompatible":
      return {
        detail: "Update the Apo CLI, then restart apo connect.",
        guidance: "Queued work will start when compatible.",
      };
    case "catalog_mismatch":
      return {
        detail: "Run apo task publish from this Task workspace.",
        guidance: "Keep apo connect running; it resumes automatically.",
      };
  }
}

function describeSourceOwnedAttempt(attempt: ExecutionAttemptSummary): Presentation {
  const queuedDeadline = attempt.queue_expires_at
    ? `Queued until ${formatAbsolute(attempt.queue_expires_at)}.`
    : null;

  if (attempt.cancel_requested_at) {
    return {
      title: "Cancelling in your connected environment…",
      detail: queuedDeadline ?? "Cancellation requested.",
      guidance: null,
      dot: "bg-muted-foreground animate-pulse",
    };
  }
  if (attempt.status === "queued") {
    const reason = attempt.waiting_reason ?? "not_connected";
    const copy = waitingCopy(reason);
    return {
      title: "Queued in your connected environment",
      detail: queuedDelay(attempt) ? `${copy.detail} ${queuedDeadline}` : copy.detail,
      guidance: copy.guidance,
      dot: "bg-muted-foreground animate-pulse",
    };
  }
  if (attempt.status === "leased") {
    return {
      title: "Preparing in your connected environment",
      detail: `Claimed ${formatAge(attempt.claimed_at)}.`,
      guidance: null,
      dot: "bg-foreground animate-pulse",
    };
  }
  if (attempt.status === "running") {
    const phase = attempt.phase ? attempt.phase.replaceAll("_", " ") : "running";
    return {
      title: "Running in your connected environment",
      detail: `Phase: ${phase}. Last heartbeat ${formatAge(attempt.heartbeat_at)}.`,
      guidance: null,
      dot: "bg-foreground animate-pulse",
    };
  }
  if (attempt.status === "lost") {
    return {
      title: "Connection lost after the Task started",
      detail: "Outcome is unknown; Apo does not infer a result or retry.",
      guidance: null,
      dot: "bg-warning",
    };
  }
  if (attempt.status === "cancelled") {
    return {
      title: "Run cancelled",
      detail: "Apo stopped tracking this attempt as active.",
      guidance: null,
      dot: "bg-muted-foreground",
    };
  }
  if (attempt.status === "failed") {
    return sourceOwnedFailure(attempt);
  }
  return {
    title: "Run finished",
    detail: "Execution attempt completed in your connected environment.",
    guidance: null,
    dot: attempt.status === "succeeded" ? "bg-success" : "bg-muted-foreground",
  };
}

function sourceOwnedFailure(attempt: ExecutionAttemptSummary): Presentation {
  if (attempt.failure_kind === "executor_unavailable") {
    return {
      title: "No compatible Connected Executor became available within 24 hours",
      detail: "The queue deadline expired before the run could start.",
      guidance: "Connect, update, or publish, then run again.",
      dot: "bg-destructive",
    };
  }
  if (attempt.failure_kind === "task_not_in_catalog") {
    return {
      title: "This Task is no longer in the published catalog",
      detail: "The Task was removed before the run could start.",
      guidance: "Refresh Tasks, then run again.",
      dot: "bg-destructive",
    };
  }
  return {
    title: "Execution failed",
    detail:
      attempt.error_message ??
      (attempt.failure_kind
        ? attempt.failure_kind.replaceAll("_", " ")
        : "The connected environment reported a failure."),
    guidance: null,
    dot: "bg-destructive",
  };
}

function queuedDelay(attempt: ExecutionAttemptSummary): boolean {
  return Boolean(attempt.queue_expires_at);
}

// ============================================================================
// Legacy Pool / bundled presentation (historical Runs)
// ============================================================================

function describePoolAttempt(
  attempt: ExecutionAttemptSummary,
  poolName: string | null,
): Presentation {
  const pool = poolName ?? "configured pool";
  if (attempt.status === "queued") {
    return {
      title: `Waiting for ${pool}`,
      detail: `Queued ${formatAge(attempt.queued_at)}. Apo will not move this run to another pool.`,
      guidance: null,
      dot: "bg-muted-foreground animate-pulse",
    };
  }
  if (attempt.status === "leased") {
    return {
      title: "Executor claimed this task",
      detail: `${attempt.executor_name ?? "Executor"} is preparing the task.`,
      guidance: null,
      dot: "bg-foreground animate-pulse",
    };
  }
  if (attempt.status === "running") {
    const phase = attempt.phase ? attempt.phase.replaceAll("_", " ") : "running";
    return {
      title: `Running on ${attempt.executor_name ?? "executor"}`,
      detail: `Phase: ${phase}. Last heartbeat ${formatAge(attempt.heartbeat_at)}.`,
      guidance: null,
      dot: "bg-foreground animate-pulse",
    };
  }
  if (attempt.status === "lost") {
    return {
      title: "Executor connection lost",
      detail: "Execution may have continued remotely, so Apo cannot safely infer a result.",
      guidance: null,
      dot: "bg-warning",
    };
  }
  if (attempt.status === "cancelled") {
    return {
      title: "Execution cancelled",
      detail: "Apo stopped tracking this attempt as active.",
      guidance: null,
      dot: "bg-muted-foreground",
    };
  }
  if (attempt.status === "failed") {
    return poolFailure(attempt.failure_kind, pool);
  }
  return {
    title: attempt.status.replaceAll("_", " "),
    detail: attempt.executor_name
      ? `Executor: ${attempt.executor_name}`
      : "Execution attempt finished.",
    guidance: null,
    dot: attempt.status === "succeeded" ? "bg-success" : "bg-muted-foreground",
  };
}

function poolFailure(
  failureKind: string | null,
  poolName: string,
): Presentation {
  const failures: Record<string, [string, string]> = {
    executor_unavailable: [
      "Executor unavailable",
      `${poolName} did not become available before the queue timeout.`,
    ],
    dependency_install_failed: [
      "Dependency setup failed",
      "The executor could not prepare the task dependencies.",
    ],
    runtime_error: ["Runtime failed", "The task process exited with a runtime error."],
    result_invalid: [
      "Task produced no result",
      "The task exited without writing a valid result file — usually a crash before completion. See the run logs for the error.",
    ],
    timeout: ["Execution timed out", "The task exceeded its configured execution limit."],
    cancelled: ["Execution cancelled", "The attempt was cancelled before completion."],
  };
  const [title, detail] = failures[failureKind ?? ""] ?? [
    "Execution failed",
    failureKind ? failureKind.replaceAll("_", " ") : "The executor reported a failure.",
  ];
  return { title, detail, guidance: null, dot: "bg-destructive" };
}

// ============================================================================
// Shared formatters
// ============================================================================

function formatAttemptTime(attempt: ExecutionAttemptSummary): string {
  const value =
    attempt.completed_at ??
    attempt.heartbeat_at ??
    attempt.started_at ??
    attempt.claimed_at ??
    attempt.queued_at;
  return new Date(value).toISOString().slice(11, 19);
}

function formatAbsolute(value: string): string {
  return new Date(value).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function formatAge(value: string | null): string {
  if (!value) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
