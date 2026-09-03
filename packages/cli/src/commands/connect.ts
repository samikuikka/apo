/**
 * apo connect — foreground Connected Executor.
 *
 * Discovers local tasks, connects to the Apo server as a persistent
 * source-owned executor, and executes assigned tasks locally.
 */

import { green, red, dim, cyan } from "../lib/format.ts";
import { parseArgs, getFlagValue } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { discoverTaskMeta } from "../lib/task-meta.ts";
import { toPublishedTask } from "../lib/task-catalog.ts";
import { computeCatalogDigest } from "../lib/task-catalog-digest.ts";
import { loadExecutorState, saveExecutorState } from "../lib/executor-state.ts";
import { walkWorkspaceForRevision } from "../lib/task-revision.ts";
import { readGitProvenance } from "../lib/git-provenance.ts";
import { runTaskChild } from "../lib/local-task-child.ts";
import {
  AttemptHeartbeatHttpError,
  bootstrapAndEnroll,
  heartbeat,
  claimWorkStructured,
  submitAttestation,
  startAttempt,
  heartbeatAttempt,
  submitResult,
  submitFailure,
  type SourceOwnedFailureKind,
  type SourceOwnedAssignment,
} from "../lib/connected-executor.ts";
import { heartbeatTimeoutMs } from "../lib/caller-execution.ts";
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** recompute the local catalog digest from the current Task root so
 * catalog changes stop new claims and recover automatically after publication. */
function computeLocalDigest(taskRoot: string): string {
  const tasks = discoverTaskMeta(taskRoot);
  const published = tasks.map(toPublishedTask).sort((a, b) => a.task_id.localeCompare(b.task_id));
  return computeCatalogDigest(published);
}

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  const dirFlag = getFlagValue(flags, "dir");
  const taskRoot = dirFlag ?? config.taskRoot ?? ".";
  const nameFlag = getFlagValue(flags, "name");
  const concurrency = parseInt(getFlagValue(flags, "concurrency") ?? "4", 10);
  const projectId = getFlagValue(flags, "project") ?? config.projectId;

  if (!projectId) {
    console.error(red("error: no project configured. Run `apo project use` first."));
    return 2;
  }
  if (!config.apiKey) {
    console.error(red("error: not logged in. Run `apo login` first."));
    return 2;
  }
  if (concurrency < 1 || !Number.isSafeInteger(concurrency)) {
    console.error(red("error: --concurrency must be a positive integer"));
    return 2;
  }

  // 1. Discover local tasks and compute digest
  const tasks = discoverTaskMeta(taskRoot);
  const published = tasks.map(toPublishedTask).sort((a, b) => a.task_id.localeCompare(b.task_id));
  let catalogDigest = computeCatalogDigest(published);
  console.log(dim(`Discovered ${published.length} task${published.length === 1 ? "" : "s"} in ${taskRoot}`));

  // 2. Load or create executor state
  let state = loadExecutorState(config.backendUrl, projectId, taskRoot);
  if (state === null) {
    console.log(dim("First connection — enrolling..."));
    try {
      state = await bootstrapAndEnroll({
        backendUrl: config.backendUrl,
        projectId,
        userAuthToken: config.apiKey!,
        name: nameFlag ?? `connected-${Date.now().toString(36)}`,
        taskRoot,
        concurrency,
      });
      saveExecutorState(state, { taskRoot });
      console.log(green(`✓ Enrolled as ${state.executor_name}`));
    } catch (err) {
      console.error(red(`error: enrollment failed: ${(err as Error).message}`));
      return 2;
    }
  } else {
    console.log(dim(`Reusing executor: ${state.executor_name}`));
  }

  // 3. Initial heartbeat + catalog check. A revoked credential is terminal
  // here; a transient error falls through to the loop's retry.
  let eligibility: Awaited<ReturnType<typeof safeHeartbeat>>;
  try {
    eligibility = await safeHeartbeat(config.backendUrl, state.credential, catalogDigest, concurrency);
  } catch (err) {
    if (err instanceof ExecutorCredentialRevoked) {
      console.error(red(`error: ${err.message}. Re-run \`apo connect\` to re-enroll.`));
      return 2;
    }
    throw err;
  }
  if (eligibility === null) return 2;

  printEligibility(eligibility, projectId, concurrency);

  // 4. Main loop
  let running = 0;
  let shouldStop = false;
  // One shutdown controller: aborting it cancels every active child's Task
  // (SIGTERM → grace → SIGKILL) so Ctrl+C stops new claims and tears down
  // active work through the same path as a Control-Plane cancellation.
  const shutdownController = new AbortController();

  const handleSignal = () => {
    if (!shouldStop) {
      shouldStop = true;
      shutdownController.abort();
      console.log(dim("\nStopping — no new claims. Active tasks will be cancelled. Press Ctrl+C again to force."));
    } else {
      console.error(red("Forcing exit."));
      process.exit(1);
    }
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  while (!shouldStop) {
    // recompute the local catalog digest each poll so a Task
    // metadata change is detected without restarting apo connect.
    catalogDigest = computeLocalDigest(taskRoot);

    // Heartbeat periodically. Revocation is terminal (same exit-2 as the
    // claim path); transient errors retry on the next iteration.
    try {
      eligibility = await safeHeartbeat(config.backendUrl, state.credential, catalogDigest, concurrency);
    } catch (err) {
      if (err instanceof ExecutorCredentialRevoked) {
        console.error(red(`error: ${err.message}. Re-run \`apo connect\` to re-enroll.`));
        return 2;
      }
      throw err;
    }
    if (eligibility === null) {
      await sleep(5000);
      continue;
    }

    if (eligibility.status !== "ready") {
      printEligibility(eligibility, projectId, concurrency);
      await sleep(10_000);
      continue;
    }

    // Claim work if we have capacity
    const availableSlots = concurrency - running;
    if (availableSlots <= 0) {
      await sleep(2000);
      continue;
    }

    let assignment: SourceOwnedAssignment | null = null;
    let retryAfterMs = 5_000;
    try {
      const claimResult = await claimWorkStructured({
        backendUrl: config.backendUrl,
        credential: state.credential,
        catalogDigest,
        availableSlots,
      });
      if (claimResult.kind === "assignment") {
        assignment = claimResult.assignment;
      } else {
        // Honor the server-advertised interval (Retry-After) instead of a tight loop.
        retryAfterMs = claimResult.retryAfterMs;
      }
    } catch (err) {
      if ((err as Error).message.includes("invalid or revoked")) {
        console.error(red("error: executor credential revoked. Re-run `apo connect` to re-enroll."));
        return 2;
      }
      console.error(dim(`claim error: ${(err as Error).message}`));
      await sleep(5000);
      continue;
    }

    if (assignment === null) {
      await sleep(retryAfterMs);
      continue;
    }

    running++;
    console.log(cyan(`\n← Assigned: ${assignment.task_id}`));

    // Execute asynchronously in an isolated child process.
    executeAssignment(config.backendUrl, taskRoot, assignment, shutdownController.signal)
      .catch((err) => console.error(red(`task ${assignment.task_id} failed: ${(err as Error).message}`)))
      .finally(() => {
        running--;
        console.log(dim(`✓ Completed: ${assignment.task_id} (${running} active)`));
      });

    await sleep(1000); // Small delay between claims
  }

  // Wait for running tasks
  console.log(dim("Waiting for active tasks to finish..."));
  while (running > 0) {
    await sleep(1000);
  }
  console.log(green("Disconnected."));
  return 0;
}

/**
 * A revoked executor credential cannot be retried into validity — the only
 * recovery is re-enrollment. Thrown by ``safeHeartbeat`` so the main loop
 * exits 2 (same as the claim path) instead of dim-error-retrying forever.
 */
class ExecutorCredentialRevoked extends Error {}

async function safeHeartbeat(
  backendUrl: string,
  credential: string,
  catalogDigest: string,
  slots: number,
) {
  try {
    return await heartbeat({ backendUrl, credential, catalogDigest, availableSlots: slots });
  } catch (err) {
    if ((err as Error).message.includes("invalid or revoked")) {
      throw new ExecutorCredentialRevoked("executor credential revoked");
    }
    console.error(dim(`heartbeat error: ${(err as Error).message}`));
    return null;
  }
}

function printEligibility(
  eligibility: NonNullable<Awaited<ReturnType<typeof safeHeartbeat>>>,
  projectId: string,
  concurrency: number,
) {
  if (eligibility.status === "ready") {
    console.log(green(`Connected to ${projectId} · catalog matches · capacity ${concurrency}`));
    console.log(dim("Waiting for assignments…  Ctrl+C to stop"));
  } else if (eligibility.status === "catalog_mismatch") {
    console.log(dim(`Catalog mismatch — run \`apo task publish\` to update.`));
  } else {
    console.log(dim(`No catalog published — run \`apo task publish\` first.`));
  }
}

async function executeAssignment(
  backendUrl: string,
  taskRoot: string,
  assignment: SourceOwnedAssignment,
  cancelSignal: AbortSignal,
  heartbeatIntervalMs: number = 30_000,
): Promise<void> {
  const completionId = `${assignment.attempt_id}-${Date.now()}`;
  // track finalization explicitly so the catch block never
  // issues a second submitFailure against a terminal Attempt (401).
  let finalized = false;
  const fail = async (
    failure_kind: SourceOwnedFailureKind,
    error_message: string,
    outcome?: { stdoutTail?: string; stderrTail?: string },
  ) => {
    finalized = true;
    await submitFailure({
      backendUrl,
      attemptJwt: assignment.attempt_jwt,
      attemptId: assignment.attempt_id,
      failure: {
        completion_id: completionId,
        failure_kind,
        error_message,
        exit_code: null,
        stdout_tail: outcome?.stdoutTail ?? null,
        stderr_tail: outcome?.stderrTail ?? null,
      },
    });
  };

  // 1. Rediscover local catalog and confirm the digest still matches the claim
  //    (the Task must not have changed between claim and execution).
  const tasks = discoverTaskMeta(taskRoot);
  const localDigest = computeCatalogDigest(
    tasks.map(toPublishedTask).sort((a, b) => a.task_id.localeCompare(b.task_id)),
  );
  if (localDigest !== assignment.catalog_digest) {
    await fail("task_import", "local catalog digest no longer matches the assignment");
    throw new Error(`catalog digest mismatch for ${assignment.task_id}`);
  }

  // 2. Resolve the exact task_id locally; never fall back to a server path.
  const task = tasks.find((t) => t.id === assignment.task_id);
  if (!task) {
    await fail("task_import", `Task ${assignment.task_id} not found locally`);
    throw new Error(`Task ${assignment.task_id} not found locally`);
  }

  // 3. Hash the current configured Task root and read sanitized Git provenance.
  const walked = walkWorkspaceForRevision({ rootDir: taskRoot });
  const git = readGitProvenance(taskRoot);

  // 4. Submit source attestation (real digest + provenance — no placeholders).
  await submitAttestation({
    backendUrl,
    attemptJwt: assignment.attempt_jwt,
    attemptId: assignment.attempt_id,
    attestation: {
      source_type: "connected_worktree",
      repository_url: git.repositoryUrl,
      base_commit_sha: git.baseCommitSha,
      dirty: git.dirty,
      content_sha256: walked.contentSha256,
      task_root_label: taskRoot.split("/").pop() || "tasks",
      file_count: walked.manifest.summary.fileCount,
      uncompressed_size_bytes: walked.manifest.summary.uncompressedSizeBytes,
    },
  });

  // 5. /start immediately before Task import/execution.
  await startAttempt({
    backendUrl,
    attemptJwt: assignment.attempt_jwt,
    attemptId: assignment.attempt_id,
  });

  // 6. Heartbeat while the isolated child runs — and through the terminal
  // /result or /failure POST (issue #176, the connect path's version of the
  // caller-path fix): every beat renews the lease, so the interval must not
  // be cleared before those submissions complete. Cancellation requests and
  // lease loss abort the child through a composed controller so a dead
  // attempt stops spending.
  const taskCancel = new AbortController();
  const onOuterCancel = (): void => taskCancel.abort();
  cancelSignal.addEventListener("abort", onOuterCancel);
  const heartbeatInterval = startAssignmentHeartbeat(
    backendUrl,
    assignment,
    () => taskCancel.abort(),
    heartbeatIntervalMs,
  );

  try {
    // 7. Run the Task in a spawned child with timeout + cancellation.
    const outcome = await runTaskChild({
      taskDir: task.path,
      envRoot: taskRoot,
      // use the configured backend base URL, not the server's
      // trace_endpoint (which is a full path that the SDK would double).
      traceEndpoint: backendUrl,
      // Explicit API base for artifact uploads.
      backendUrl,
      project: assignment.project,
      taskRunId: assignment.task_run_id,
      traceRequired: true,
      attemptJwt: assignment.attempt_jwt,
      timeoutSeconds: assignment.timeout_seconds,
      cancelSignal: taskCancel.signal,
    });

    if (!outcome.ok) {
      const isArtifactError = outcome.error?.startsWith("artifact_persistence:");
      const failure_kind: SourceOwnedFailureKind = isArtifactError
        ? "driver"
        : outcome.timedOut
          ? "timeout"
          : "task_runtime";
      finalized = true;
      await submitFailure({
        backendUrl,
        attemptJwt: assignment.attempt_jwt,
        attemptId: assignment.attempt_id,
        failure: {
          completion_id: completionId,
          failure_kind,
          error_message: outcome.error,
          exit_code: null,
          stdout_tail: outcome.stdoutTail || null,
          stderr_tail: outcome.stderrTail || null,
        },
      });
      if (outcome.timedOut) throw new Error(`task timed out after ${assignment.timeout_seconds}s`);
      throw new Error(outcome.error);
    }

    // 8. Submit the full structured result (checks, trace, deliverables,
    //    transcript, model/effort) from the isolated child.
    const summary = outcome.summary as {
      pass?: boolean;
      adapterName?: string;
      checks?: unknown;
      traceRunId?: string;
      deliverables?: Record<string, unknown>;
      transcript?: Record<string, unknown>;
      runConfiguration?: { model: string; effort?: string };
    };
    // Issue #175: ship only what the server keeps. Oversized
    // received values / judge segments become the backend's truncation
    // markers here, so judging one large document N times doesn't upload N
    // copies of it. Compaction is an optimization — if the SDK module
    // somehow fails to load, submit the raw checks rather than fail the run.
    let checksForSubmission: unknown = summary.checks ?? null;
    try {
      const { compactChecksForSubmission } = await import("@apo-ai/sdk/agent-task");
      if (Array.isArray(checksForSubmission)) {
        checksForSubmission = compactChecksForSubmission(
          checksForSubmission as Parameters<typeof compactChecksForSubmission>[0],
        ).checks;
      }
    } catch {
      // fall through with the raw checks
    }
    // Once result submission begins, the server may commit before we
    // see the response. Do not send a contradictory failure on a dropped response.
    finalized = true;
    await submitResult({
      backendUrl,
      attemptJwt: assignment.attempt_jwt,
      attemptId: assignment.attempt_id,
      result: {
        completion_id: completionId,
        pass_result: summary.pass ?? false,
        adapter_name: summary.adapterName ?? null,
        checks: checksForSubmission,
        trace_run_id: summary.traceRunId ?? null,
        transcript: summary.transcript ?? null,
        deliverables: summary.deliverables ?? null,
        run_configuration: summary.runConfiguration ?? null,
        exit_code: null,
        stdout_tail: outcome.stdoutTail || null,
        stderr_tail: outcome.stderrTail || null,
        error_message: null,
      },
    });
  } catch (err) {
    // only submit a failure if no finalization has happened.
    if (!finalized) {
      await fail("task_runtime", (err as Error).message);
    }
    throw err;
  } finally {
    // The heartbeat outlives the child on purpose (issue #176): cleared
    // here — after the terminal /result or /failure POST resolved.
    clearInterval(heartbeatInterval);
    cancelSignal.removeEventListener("abort", onOuterCancel);
  }
}

/**
 * Beats for one source-owned assignment: renews the lease, honors
 * cancellation, and reports problems loudly instead of swallowing them
 * (issue #176 — a silently dead beat stream loses the run as `lost`, and a
 * dropped cancel_requested keeps a cancelled Task spending).
 */
function startAssignmentHeartbeat(
  backendUrl: string,
  assignment: SourceOwnedAssignment,
  abortChild: () => void,
  intervalMs: number,
): ReturnType<typeof setInterval> {
  let consecutiveFailures = 0;
  let aborted = false;
  let leaseLostAnnounced = false;
  const cancelOnce = (): void => {
    if (aborted) return;
    aborted = true;
    abortChild();
  };
  const beat = async (): Promise<void> => {
    try {
      const { cancel_requested } = await heartbeatAttempt({
        backendUrl,
        attemptJwt: assignment.attempt_jwt,
        attemptId: assignment.attempt_id,
        phase: "running",
        timeoutMs: heartbeatTimeoutMs(intervalMs),
      });
      consecutiveFailures = 0;
      if (cancel_requested && !aborted) {
        console.error(red("Warning: backend requested cancellation — stopping the Task"));
      }
      if (cancel_requested) cancelOnce();
    } catch (err) {
      if (err instanceof AttemptHeartbeatHttpError && err.status === 409) {
        // Terminal: no result can be submitted against a lost lease. Stop
        // the Task instead of finishing work the backend will discard.
        if (!leaseLostAnnounced) {
          leaseLostAnnounced = true;
          console.error(
            red(
              "Warning: lease lost (backend returned 409 for the heartbeat) — " +
                "this attempt can no longer be finalized",
            ),
          );
        }
        cancelOnce();
        return;
      }
      consecutiveFailures += 1;
      console.error(
        `Warning: heartbeat failed (${consecutiveFailures} in a row): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  };
  // Beat immediately after /start, then on the interval.
  void beat();
  return setInterval(() => void beat(), intervalMs);
}

// Test-only export: executeAssignment is otherwise module-private. Exposed so
// the connector assignment scene test can drive it with a mocked Control Plane
// and a stubbed child spawner without spawning a real apo connect process.
export const __executeAssignmentForTest = executeAssignment;
