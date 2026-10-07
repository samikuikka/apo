import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { getBoolFlag, parseArgs, requirePositional } from "../lib/args.ts";
import { resolveConfig, type Config } from "../lib/config.ts";
import { apiGet, isBackendReachable } from "../lib/api.ts";
import { discoverTaskMeta, findTaskMetaById } from "../lib/task-meta.ts";
import { bold, dim, formatJson, red, runVerdict, verdictExitCode } from "../lib/format.ts";
import type { CheckResult } from "../lib/agent-task-types.ts";
import { NO_VERDICT_MESSAGE_PREFIX, formatChecks, isNoVerdict, secondJudgeSummary } from "../lib/checks-format.ts";
import { NO_CHECKS_REGISTERED_MESSAGE } from "@apo-ai/sdk/agent-task";
import { walkWorkspaceForRevision } from "../lib/task-revision.ts";
import { prepareTaskDefinition } from "../lib/task-definition.ts";
import { readGitProvenance, buildCallerIdentity } from "../lib/git-provenance.ts";
import {
  createCallerRun,
  startCallerAttempt,
  submitCallerResult,
  submitCallerFailure,
  CallerHeartbeat,
  type CallerResultBody,
  type CreatedCallerRun,
} from "../lib/caller-execution.ts";
import {
  ResultSubmissionHttpError,
  formatResultTooLarge,
  prepareResultSubmission,
  type ResultBodySize,
} from "../lib/result-submission.ts";
import { externalizeResultEvidence, ResultEvidenceTooLargeError } from "../lib/result-evidence.ts";
import { maybeStartCollector, type MaybeCollector } from "../lib/collector.ts";

export type LocalRunSummary = {
  taskId: string;
  pass: boolean;
  /** Every failing check got no verdict from the judge (issue #323). */
  noVerdict?: boolean;
  /** The backend recorded the run as a judge no-verdict although the local
   * checks said otherwise (version skew between SDK and backend). */
  recordedNoVerdict?: boolean;
  /** The backend recorded the run as an execution error (#149 generations,
   * #13 executor): no verdict, and not the judge's doing. Its message. */
  recordedError?: string;
  /** The backend recorded a plain FAIL where the local checks read no
   * verdict: it predates the judge no-verdict rule (#323). */
  recordedFailPredatesRule?: boolean;
  /** The recorded verdict could not be read back after the result was
   * accepted, so the local verdict is shown. */
  recordedVerdictUnconfirmed?: boolean;
  /** The SDK reported `noVerdict` itself — 0.8+, whose rejudge accepts a
   * no-verdict run. */
  sdkReportsNoVerdict?: boolean;
  checks: CheckResult[];
  adapterName?: string;
  traceRunId?: string;
  deliverables?: Record<string, unknown>;
  transcript?: Record<string, unknown>;
  runConfiguration?: { model: string; effort?: string };
};

/** Told whether a finished run's verdict was NO VERDICT — exit code 2 alone
 * can't tell it apart from an execution error (`apo run` labels by it). */
export type VerdictObserver = (noVerdict: boolean) => void;

export async function run(argv: string[], observeVerdict?: VerdictObserver): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const taskRef = requirePositional(positional, 0, "task-id | path");

  const flagRemote = getBoolFlag(flags, "remote");
  const executorFlag = typeof flags["executor"] === "string" ? flags["executor"] : undefined;
  const noRecord = getBoolFlag(flags, "no-record");

  // Execution-target compat. task run always executes on this machine (caller
  // execution); --remote and pool targets no longer exist, so they fail
  // loudly instead of silently running somewhere the caller didn't ask for.
  if (flagRemote) {
    console.error(red("error: --remote is not supported — task run always executes on this machine (caller execution)"));
    return 2;
  }
  if (executorFlag) {
    console.error(red(`error: --executor is not supported — task run always executes on this machine (caller execution)`));
    return 2;
  }

  // Resolve the task's filesystem path + its declared execution preference.
  // We read `execution` statically (no module load) so we don't re-register
  // checks just to pick a dispatch mode.
  const resolved = resolveTask(taskRef, config.taskRoot);
  if (!resolved) {
    console.error(`Task not found: ${taskRef}`);
    return 2;
  }

  // caller execution is the only recorded runtime. --no-record
  // forces an unrecorded local run.
  if (noRecord) {
    return runLocally(config, resolved.taskDir, observeVerdict);
  }

  // Default recorded path: caller create-and-claim.
  if (config.projectId && config.apiKey) {
    if (await isBackendReachable(config.backendUrl)) {
      return runCallerRecorded(config, resolved, observeVerdict);
    }
    console.error(`${red("error:")} backend unreachable; configured recording failed (use --no-record to run unrecorded)`);
    return 2;
  }

  // No project or credential configured → run unrecorded with a notice.
  console.error(`${dim("note:")} run is not being recorded (no project or credential configured)`);
  return runLocally(config, resolved.taskDir, observeVerdict);
}

/**
 * Dispatch to the Issue #4 local-recorded path, applying the reachability
 * fallback it has always had: if the backend isn't reachable (or no project
 * is set), degrade to an unrecorded local run with a warning. The implicit
 * task/project paths inherit the exact same fallback.
 */
type ResolvedTask = {
  taskId: string | undefined;
  taskDir: string;
};

function resolveTask(ref: string, taskRoot: string): ResolvedTask | null {
  const asPath = resolve(ref);
  if (existsSync(asPath)) {
    const meta = discoverTaskMeta(taskRoot).find(
      (t) => resolve(t.path) === asPath,
    );
    return {
      taskDir: asPath,
      taskId: meta?.id,
    };
  }

  const match = findTaskMetaById(taskRoot, ref);
  if (!match) return null;
  return {
    taskDir: match.path,
    taskId: match.id,
  };
}

async function runLocally(
  config: Config,
  taskDir: string,
  observeVerdict?: VerdictObserver,
): Promise<number> {
  loadEnvFiles(taskDir);
  const { runTaskDir } = await import("@apo-ai/sdk/agent-task");

  let summary: LocalRunSummary;
  try {
    console.log(dim(`Running task from ${taskDir}...`));
    summary = withNoVerdict(await runTaskDir(taskDir));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(`Error: ${message}`));
    return 2;
  }

  if (config.json) {
    console.log(formatJson(summary));
  } else {
    printLocalRunSummary(summary, null);
  }

  observeVerdict?.(summary.noVerdict === true);
  return verdictExitCode(summary.pass, summary.noVerdict === true);
}

/**
 * Stamp `noVerdict` from the check outcomes. Newer SDKs set it themselves;
 * deriving it here keeps the verdict right against older ones. `pass` and
 * the `pass_result` sent to the backend are unchanged — the backend applies
 * the same rule to the recorded checks.
 */
function withNoVerdict(summary: LocalRunSummary): LocalRunSummary {
  const sdkReportsNoVerdict = summary.noVerdict === true;
  const noVerdict = sdkReportsNoVerdict || isNoVerdict(summary.checks);
  return noVerdict ? { ...summary, noVerdict: true, sdkReportsNoVerdict } : summary;
}

/**
 * recorded caller execution. Hashes the real caller workspace, creates
 * + claims one Attempt, /start, runs the SDK Task locally with the Attempt JWT
 * in the child env (never the Project API key), heartbeats, and submits the
 * result/failure through the scoped protocol.
 */
async function runCallerRecorded(
  config: Config,
  resolved: ResolvedTask,
  observeVerdict?: VerdictObserver,
): Promise<number> {
  const taskDir = resolved.taskDir;
  const taskId = resolved.taskId ?? taskDir;
  const backendUrl = config.backendUrl;

  // 1. Build the attestation over the actual caller bytes + Git provenance.
  const walked = walkWorkspaceForRevision({ rootDir: config.taskRoot });
  const git = readGitProvenance(config.taskRoot);
  const identity = buildCallerIdentity({ clientVersion: "0.1.0" });

  // Every recorded run carries its canonical local Task Definition.
  // Fail before creating the Run if source cannot be prepared: a source-less
  // recorded Run cannot render its Tests and violates the caller contract.
  let taskDefinition;
  try {
    const allMeta = discoverTaskMeta(config.taskRoot);
    const taskMeta = allMeta.find((m) => m.id === taskId) ?? allMeta.find((m) => m.path === taskDir);
    if (!taskMeta) {
      throw new Error(
        `Task '${taskId}' has no canonical *.eval.ts definition under ${config.taskRoot}`,
      );
    }
    taskDefinition = prepareTaskDefinition(taskMeta).document;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(`Error: could not prepare Task definition: ${message}`));
    return 2;
  }

  // 2. Create-and-claim.
  let created;
  try {
    created = await createCallerRun({
      backendUrl, apiKey: config.apiKey ?? "", project: config.projectId ?? "",
      task: {
        task_id: taskId, task_path: taskId, display_name: taskId,
        adapter_name: null, has_checks: false,
      },
      environment: "default", runMetadata: { trigger: { source: "cli", executor: "caller" } },
      attestation: {
        source_type: "caller_worktree",
        repository_url: git.repositoryUrl,
        base_commit_sha: git.baseCommitSha,
        dirty: git.dirty,
        content_sha256: walked.contentSha256,
        task_root_label: config.taskRoot,
        file_count: walked.manifest.summary.fileCount,
        uncompressed_size_bytes: walked.manifest.summary.uncompressedSizeBytes,
      },
      identity,
      taskDefinition,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(`Error: caller create-and-claim failed: ${message}`));
    return 2;
  }

  console.log(dim(`Executor: caller (recorded in project ${config.projectId})`));
  console.log(dim(
    `Revision: ${git.dirty ? "dirty worktree" : "clean worktree"} ` +
    `${git.baseCommitSha ?? "(no commit)"}` +
    (git.repositoryUrl ? ` from ${git.repositoryUrl}` : ""),
  ));

  // 3. Thread only Task-scoped values to the child SDK (Attempt JWT, not API key).
  // Use the backend URL this CLI is configured with, not the one the server
  // reports. `created.traceEndpoint` comes from the server's own APO_BACKEND_URL,
  // which a server behind a reverse proxy cannot know — it defaults to
  // http://127.0.0.1:8000, so the child SDK posts its spans at the developer's
  // own machine and the trace silently arrives with only the runtime's spans in
  // it. We just completed authenticated requests against config.backendUrl, so it
  // is known-reachable; the sibling dispatch path below already uses it. A
  // deployment that wants telemetry on a different ingress configures it here,
  // client-side, rather than relying on the server to guess its own address.
  //
  // With span buffering on (remote backends, or APO_COLLECTOR=1), traces go
  // through the local collector instead: the run's spans queue on disk through
  // network drops and backend outages. Result/artifact traffic still goes to
  // the backend directly.
  const collector = await maybeStartCollector({
    backendUrl: config.backendUrl,
    authHeader: config.apiKey ? `Bearer ${config.apiKey}` : null,
    log: (line) => console.log(dim(line)),
    warn: (line) => console.error(red(`Warning: ${line}`)),
  });
  process.env.AGENT_TASK_TRACE_ENDPOINT =
    (collector.traceEndpoint ?? config.backendUrl).replace(/\/$/, "");
  // Backend base for SDK API consumers (projection reads, history, scores):
  // with span buffering on, the trace endpoint is the OTLP-only collector.
  process.env.APO_BACKEND_URL = config.backendUrl.replace(/\/$/, "");
  // AGENT_TASK_PROJECT is the name the SDK reads (task-runtime.ts gates tracing on
  // endpoint && AGENT_TASK_PROJECT). This used to set AGENT_TASK_TRACE_PROJECT,
  // which nothing reads, so caller execution fell through to noop tracing: no
  // trace was recorded, and — because no OTel span was ever active — a runtime
  // that nests under a propagated traceparent opened its own unlinked root
  // instead. Silent, despite AGENT_TASK_TRACE_REQUIRED below.
  process.env.AGENT_TASK_PROJECT = created.traceProject;
  process.env.AGENT_TASK_RUN_ID = created.taskRunId;
  process.env.AGENT_TASK_TRACE_REQUIRED = "true";
  process.env.APO_AUTH_TOKEN = created.lease.token;
  // The judge's history plane reads run reports from the backend, which
  // accepts project credentials — not the executor-protocol attempt token
  // above. Export the caller's own API key for those in-process reads (the
  // SDK prefers it over APO_AUTH_TOKEN); restored in the cleanup paths next
  // to APO_AUTH_TOKEN. Only injected when not already present so a caller's
  // explicit APO_API_KEY is never clobbered or deleted.
  const injectedApiKey = config.apiKey && !process.env.APO_API_KEY ? config.apiKey : undefined;
  if (injectedApiKey) process.env.APO_API_KEY = injectedApiKey;

  // 4. Import the SDK BEFORE /start (issue #108). Startup failures (package
  // not found, module-resolution errors) must happen pre-start so the lease
  // reaper requeues the attempt instead of marking it LOST with the misleading
  // "after task code started" message. The trace env vars are already set
  // (step 3), and the SDK reads them at import time — no /start dependency.
  let runTaskDirImpl: (
    taskDir: string,
    options?: { registerCancel?: (cancel: (reason?: string) => Promise<void>) => void },
  ) => Promise<unknown>;
  let persistFileArtifactsImpl: typeof import("@apo-ai/sdk/agent-task").persistFileArtifacts | undefined;
  let compactChecksImpl: typeof import("@apo-ai/sdk/agent-task").compactChecksForSubmission | undefined;
  try {
    const mod = await import("@apo-ai/sdk/agent-task");
    runTaskDirImpl = mod.runTaskDir;
    persistFileArtifactsImpl = mod.persistFileArtifacts;
    compactChecksImpl = mod.compactChecksForSubmission;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(`Error: failed to load task SDK: ${message}`));
    await releasePreRunState(collector, injectedApiKey);
    return 2;
  }

  // 5. /start (now after a successful SDK import — startup failures are pre-start).
  try {
    await startCallerAttempt(backendUrl, created.lease);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(`Error: /start failed: ${message}`));
    await releasePreRunState(collector, injectedApiKey);
    return 2;
  }

  // 6. Run the Task locally with a background heartbeat.
  const heartbeat = new CallerHeartbeat(backendUrl, created.lease, () => {
    console.error(red("Warning: lease reported stale/cancelled"));
  });
  heartbeat.start("running");
  loadEnvFiles(taskDir);

  // Graceful termination for the in-process run: without a handler, Ctrl+C
  // kills the CLI mid-run with the root span unfinished — the backend keeps
  // every step span but loses the span that links the trace to the run row.
  // End the root span as cancelled, flush it bounded, then exit; the lease
  // reaper requeues the attempt server-side.
  let cancelTrace: ((reason?: string) => Promise<void>) | undefined;
  let terminating = false;
  const handleTermSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    if (terminating) return;
    terminating = true;
    console.error(red(`\nReceived ${signal} — cancelling run, flushing trace…`));
    const exitCode = signal === "SIGINT" ? 130 : 143;
    const bail = setTimeout(() => process.exit(exitCode), 4_000);
    const flush = cancelTrace ? cancelTrace("cancelled") : Promise.resolve();
    void flush
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(bail);
        process.exit(exitCode);
      });
  };
  const onRunSigint = (): void => handleTermSignal("SIGINT");
  const onRunSigterm = (): void => handleTermSignal("SIGTERM");
  process.once("SIGINT", onRunSigint);
  process.once("SIGTERM", onRunSigterm);

  const completionId = `${created.lease.attemptId}-${created.lease.generation}`;
  let exitCode = 0;
  let resultStarted = false;
  let artifactPhase = false;
  // Visible to the catch block: when the result POST fails at the transport
  // level (Issue #174) the run may still have committed, and the recovery
  // path needs the summary to render the verdict it confirmed server-side.
  let summary: LocalRunSummary | null = null;
  let jsonDeliverables: Record<string, unknown> = {};
  // The measurement of the final serialized body, kept for the definite-413
  // branch so its diagnostic can name bytes/limit/fields (issue #249).
  let measuredSize: ResultBodySize | null = null;
  try {
    summary = withNoVerdict(await runTaskDirImpl(taskDir, {
      registerCancel: (cancel) => {
        cancelTrace = cancel;
      },
    }) as LocalRunSummary);

    // Upload file artifacts after checks, before result submission.
    // Issue #176: the heartbeat stays alive through this and the /result
    // POST below — both are slow (multi-MB uploads + SQLite finalize) and
    // used to happen after `heartbeat.stop()`, so anything slower than the
    // lease TTL in that window was reaped mid-submission and a completed
    // run died as `lease_stale … cannot finalize from 'lost'`. Every beat
    // renews the lease server-side; stopping happens in the finally, after
    // the terminal POST.
    const rawDeliverables = summary.deliverables ?? {};
    if (persistFileArtifactsImpl) {
      artifactPhase = true;
      const prepared = await persistFileArtifactsImpl(rawDeliverables, {
        taskRunId: created.taskRunId,
        authToken: created.lease.token,
        baseUrl: backendUrl,
        fetch,
      });
      artifactPhase = false;
      jsonDeliverables = prepared.jsonDeliverables;
    }

    resultStarted = true;
    // Issue #175: submit only what the server keeps. The backend
    // truncates oversized received values and judge segments into markers at
    // persist time anyway; compacting here means a task judging one large
    // document N times ships N tiny markers instead of N copies of the
    // document (43 MB bodies → single-digit MB). Local rendering and --json
    // output above still use the full summary.
    let checksForSubmission: unknown;
    if (compactChecksImpl) {
      // A compaction failure is a recording error, not a reason to upload
      // the raw checks: report it instead of attempting a huge body (issue #249).
      try {
        // Fresh SDK results: judge segments are strings, never stored markers.
        checksForSubmission = compactChecksImpl(
          summary.checks as Parameters<typeof compactChecksImpl>[0],
        ).checks;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`check compaction failed: ${detail}`);
      }
    } else {
      checksForSubmission = summary.checks;
    }
    const resultBody: CallerResultBody = {
      completion_id: completionId,
      pass_result: summary.pass,
      adapter_name: summary.adapterName ?? null,
      trace_run_id: summary.traceRunId ?? null,
      checks: checksForSubmission as unknown,
      transcript: summary.transcript ?? null,
      deliverables: jsonDeliverables,
      run_configuration: summary.runConfiguration ?? null,
    };
    // Issue #249: the server advertises the exact byte cap its middleware
    // enforces. Measure the final serialized body once; a known-oversized
    // result is either staged out of band (issue #251, when the server
    // advertises evidence support) or finalized as a bounded execution
    // error through the small failure endpoint instead of dying as a 413
    // with no inspectable outcome.
    const prepared = prepareResultSubmission(resultBody, created.resultMaxBytes);
    measuredSize = prepared.size;
    if (prepared.overLimit && created.evidence) {
      // Issue #251: the transcript/deliverables/checks leave the envelope
      // as verified evidence parts and the result references them by id.
      // Uploads run inside the heartbeat window this command already
      // keeps open through submission (issue #176).
      try {
        const externalized = await externalizeResultEvidence({
          ctx: {
            backendUrl,
            attemptId: created.lease.attemptId,
            authToken: created.lease.token,
            protocolVersion: 1,
          },
          support: created.evidence,
          body: resultBody as unknown as Record<string, unknown>,
          limitBytes: created.resultMaxBytes,
        });
        const rePrepared = prepareResultSubmission(
          externalized.body,
          created.resultMaxBytes,
        );
        if (rePrepared.overLimit) {
          // Cannot happen unless the server rejects its own advertisement;
          // treat as a definite size rejection rather than sending it.
          throw new ResultEvidenceTooLargeError(
            `${formatResultTooLarge(rePrepared.size)} after_evidence_externalization`,
          );
        }
        await submitCallerResult(
          backendUrl,
          created.lease,
          externalized.body as unknown as CallerResultBody,
          rePrepared.serialized,
        );
        const recorded = await pollRunVerdict(config, created.taskRunId, 1, 0);
        exitCode = renderRecordedResult(
          config,
          withRecordedVerdict(summary, recorded),
          jsonDeliverables,
          created.taskRunId,
          observeVerdict,
        );
      } catch (error) {
        if (error instanceof ResultEvidenceTooLargeError) {
          // Even out of band the result could not fit: fall through to the
          // bounded rejection, the same contract as an unsupported server.
          const diagnostic = error.message.slice(0, 2_000);
          await finalizeResultInvalid(config, created, completionId, diagnostic, heartbeat);
          console.error(red(`Error: ${diagnostic}`));
          exitCode = 2;
        } else {
          throw error;
        }
      }
    } else if (prepared.overLimit) {
      let diagnostic = formatResultTooLarge(prepared.size);
      if (!compactChecksImpl) {
        diagnostic += " (check compaction unavailable in this SDK — values were not compacted)";
      }
      await finalizeResultInvalid(config, created, completionId, diagnostic, heartbeat);
      console.error(red(`Error: ${diagnostic}`));
      exitCode = 2;
    } else {
      await submitCallerResult(backendUrl, created.lease, resultBody, prepared.serialized);
      // render the result so the CLI shows PASS/FAIL + checks,
      // just like the local and backend paths it replaced — with the
      // verdict the backend recorded, which is authoritative (#149, #323).
      const recorded = await pollRunVerdict(config, created.taskRunId, 1, 0);
      exitCode = renderRecordedResult(
        config,
        withRecordedVerdict(summary, recorded),
        jsonDeliverables,
        created.taskRunId,
        observeVerdict,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof ResultSubmissionHttpError &&
      error.status === 413 &&
      resultStarted
    ) {
      // An explicit 413 is a definite rejection of this request — the body
      // never reached finalization (an intermediary may enforce a smaller
      // cap than the server advertised). Finalize as a bounded execution
      // error while the lease is live; this is NOT the ambiguous branch.
      const diagnostic = measuredSize
        ? `${formatResultTooLarge(measuredSize)} server_rejected_with=413`
        : `result_too_large: server rejected the result body with HTTP 413`;
      await finalizeResultInvalid(config, created, completionId, diagnostic, heartbeat);
      console.error(red(`Error: ${diagnostic}`));
      exitCode = 2;
    } else if (resultStarted) {
      // Ambiguous result — the server may have committed before the
      // connection failed. Do NOT send a contradictory failure.
      // Issue #174: the transport giving up on a multi-MB body (ingress
      // timeout, dropped connection) says nothing about the backend — it may
      // still be finalizing the very result it stopped acknowledging. Re-poll
      // the run's authoritative state before declaring the outcome unknown.
      console.error(red(`Error: result submission failed: ${message}`));
      // The lease's job was to protect the terminal POST, which is over.
      // Stop the beat before polling: if the backend already committed the
      // result, every further beat 409s ("cannot heartbeat from
      // 'succeeded'") and would print a misleading lease-lost warning.
      await heartbeat.stop();
      console.error(dim("Checking whether the backend still recorded the run..."));
      const verdict = await pollRunVerdict(config, created.taskRunId);
      if (verdict && summary) {
        console.error(dim(`Result recorded: run ${created.taskRunId} is ${verdict.status}.`));
        // The recorded verdict is authoritative, the same mapping as a
        // normal submit: whatever the local checks said.
        exitCode = renderRecordedResult(
          config,
          withRecordedVerdict(summary, verdict),
          jsonDeliverables,
          created.taskRunId,
          observeVerdict,
        );
      } else {
        console.error(
          red(`Error: result submission outcome unknown: ${message}`) + "\n" +
          dim(`Run ${created.taskRunId} (apo runs show ${created.taskRunId})`),
        );
        exitCode = 2;
      }
    } else {
      try {
        await submitCallerFailure(backendUrl, created.lease, {
          completion_id: completionId,
          failure_kind: artifactPhase ? "driver" : "task_runtime",
          error_message: message,
        });
        // The failure was still recorded — hand the user the
        // exact Run identity so onboarding can continue from the evidence.
        console.error(
          dim(`Recorded run ${created.taskRunId} (apo runs show ${created.taskRunId})`),
        );
      } catch (reportError) {
        const reportMessage = reportError instanceof Error ? reportError.message : String(reportError);
        console.error(red(`Warning: failed to report failure to backend: ${reportMessage}`));
      }
      console.error(red(`Error: ${message}`));
      exitCode = 2;
    }
  } finally {
    // The heartbeat outlives the Task body on purpose (issue #176): it is
    // stopped here — after the terminal result/failure POST resolved — and
    // exactly once, for every path through the try/catch above.
    await heartbeat.stop();
    delete process.env.APO_AUTH_TOKEN;
    if (injectedApiKey) delete process.env.APO_API_KEY;
    process.removeListener("SIGINT", onRunSigint);
    process.removeListener("SIGTERM", onRunSigterm);
    await releaseCollector(collector);
  }
  return exitCode;
}

/**
 * The pre-run failure paths (SDK import, /start) own the same run-scoped
 * state the run's finally releases — executor env vars and the collector
 * handle. Nothing else exists yet: no heartbeat, no signal handlers. Without
 * this, a failed /start leaves this command registered as a live collector
 * user (pruned only by a later command) and the collector it spawned
 * unattended until the next apo command stops it.
 */
async function releasePreRunState(
  collector: MaybeCollector,
  injectedApiKey?: string,
): Promise<void> {
  delete process.env.APO_AUTH_TOKEN;
  if (injectedApiKey) delete process.env.APO_API_KEY;
  await releaseCollector(collector);
}

/** Release the collector handle, saying so when it must keep running. */
async function releaseCollector(collector: MaybeCollector): Promise<void> {
  if ((await collector.stop()) === "left-running") {
    console.log(dim(
      "Local collector left running — it is still delivering queued traces, " +
      "or another apo command may be using it; the next command that spawns it " +
      "stops it once drained.",
    ));
  }
}

function printLocalRunSummary(summary: LocalRunSummary, taskRunId: string | null): void {
  console.log("");
  const noVerdict = summary.noVerdict === true;
  const header = summary.recordedError !== undefined ? red("ERROR") : runVerdict(summary.pass, noVerdict);
  console.log(`${header} ${bold(summary.taskId)}`);

  if (summary.checks.length > 0) {
    console.log(bold("  Checks:"));
    console.log(formatChecks(summary.checks));
    const sjSummary = secondJudgeSummary(summary.checks);
    if (sjSummary) console.log(dim(`\n  ${sjSummary}`));
  } else if (!summary.pass && !noVerdict && summary.recordedError === undefined) {
    // Issue #8: a failed run with zero checks is almost always a silent
    // registration bug (e.g. a double-import that wiped the check registry).
    // Don't leave the user staring at a bare FAIL — say what went wrong.
    console.log(`  ${NO_CHECKS_REGISTERED_MESSAGE}`);
  }
  if (summary.recordedError !== undefined) {
    console.log(`\n  ${red("Error:")} ${summary.recordedError.slice(0, 500)}`);
  }
  if (noVerdict) console.log(dim(`\n  ${noVerdictHint(summary, taskRunId)}`));
  if (summary.recordedFailPredatesRule) {
    console.log(
      dim(
        "\n  Recorded as FAIL by this backend (it predates the no-verdict rule): " +
          "the only non-passing checks above got no verdict from the judge.",
      ),
    );
  }
  if (summary.recordedVerdictUnconfirmed) {
    console.log(
      dim("\n  Could not confirm the verdict the backend recorded; showing the local verdict."),
    );
  }
}

const NO_JUDGE_CONFIGURED = "No judge model configured";

/**
 * What to do about a NO VERDICT, per cause: a missing judge needs
 * configuring; a judge that never answered needs a re-run, or — on a
 * recorded run — a human verdict via `apo runs correct` (`apo runs rejudge`
 * records a separate judgment and leaves the run's own verdict unchanged).
 */
function noVerdictHint(summary: LocalRunSummary, taskRunId: string | null): string {
  if (summary.recordedNoVerdict) {
    return `No verdict: the backend recorded this run without one — see apo runs show ${taskRunId ?? "<run-id>"} for why.`;
  }
  const failing = summary.checks.filter((c) => !c.pass);
  const unconfigured = failing.every((c) =>
    [c.reasoning, ...(c.assertions ?? []).map((a) => a.reasoning)].some((r) =>
      r?.startsWith(NO_JUDGE_CONFIGURED),
    ),
  );
  if (unconfigured) {
    const configure =
      "No verdict: no judge model is configured — set OPENROUTER_MODEL (or OPENAI_MODEL) and its API key, then re-run";
    // Re-judging a no-verdict run needs an SDK that knows the rule (0.8+);
    // an older one refuses it, so don't offer what would fail.
    if (taskRunId && summary.sdkReportsNoVerdict) {
      return `${configure}, or judge this run as recorded: apo runs rejudge ${taskRunId} --judge-model <model>.`;
    }
    return `${configure}.`;
  }
  const base = "No verdict: the judge gave no answer for the non-passing checks.";
  if (!taskRunId) return `${base} Re-run the task.`;
  return (
    `${base} Re-run the task, or record the verdict yourself with ` +
    `apo runs correct ${taskRunId} <test-id> --pass|--fail --reason <why> ` +
    `(apo runs rejudge records a separate judgment; the run's verdict stays as is).`
  );
}

/** Render a recorded run's verdict and hand over its exact identity. */
function renderRecordedResult(
  config: Config,
  summary: LocalRunSummary,
  jsonDeliverables: Record<string, unknown>,
  taskRunId: string,
  observeVerdict?: VerdictObserver,
): number {
  if (config.json) {
    console.log(JSON.stringify({ ...summary, deliverables: jsonDeliverables }));
  } else {
    printLocalRunSummary(summary, taskRunId);
    // Hand over the exact recorded identity — onboarding copy
    // must never rely on "latest run" lookup.
    console.log(`\nRun:     ${bold(taskRunId)}`);
    console.log(`Inspect: ${dim(`apo runs show ${taskRunId}`)}`);
  }
  observeVerdict?.(summary.noVerdict === true);
  if (summary.recordedError !== undefined) return 2;
  return verdictExitCode(summary.pass, summary.noVerdict === true);
}

/**
 * Map the verdict the backend recorded onto the local summary — the
 * backend is authoritative (it applies #149 and the judge no-verdict rule to
 * the recorded checks). PASS/FAIL as recorded; a judge no-verdict is NO
 * VERDICT; any other `error` is an execution error with its message. With
 * no readable verdict (`null`) the local summary stands.
 */
export function withRecordedVerdict(
  summary: LocalRunSummary,
  recorded: RecordedVerdict | null,
): LocalRunSummary {
  if (!recorded) return { ...summary, recordedVerdictUnconfirmed: true };
  if (recorded.status === "passed" || recorded.status === "failed") {
    const predatesRule =
      recorded.status === "failed" &&
      recorded.noVerdictReason === undefined &&
      summary.noVerdict === true;
    return {
      ...summary,
      pass: recorded.status === "passed",
      noVerdict: false,
      ...(predatesRule ? { recordedFailPredatesRule: true } : {}),
    };
  }
  // A backend without the field is read by the rule's own message, as every
  // other fallback does: the local checks can disagree with the recorded run
  // (#149 dominated, or SDK/backend skew).
  const judge =
    recorded.noVerdictReason === "judge" ||
    (recorded.noVerdictReason === undefined &&
      (recorded.errorMessage ?? "").startsWith(NO_VERDICT_MESSAGE_PREFIX));
  if (judge) {
    return { ...summary, pass: false, noVerdict: true, recordedNoVerdict: summary.noVerdict !== true };
  }
  return {
    ...summary,
    pass: false,
    noVerdict: false,
    recordedError: recorded.errorMessage ?? "the run errored",
  };
}

/**
 * Finalize a definitely-rejected result as a bounded execution error
 * (issue #249): a small /failure POST with failure_kind "result_invalid" and
 * a `result_too_large:` diagnostic, while the lease is still live. If the
 * failure finalization itself cannot be acknowledged, fall back to polling
 * the run's authoritative state — a committed result is never contradicted.
 * Every path prints the exact Run identity so the failure stays inspectable.
 */
async function finalizeResultInvalid(
  config: Config,
  created: CreatedCallerRun,
  completionId: string,
  diagnostic: string,
  heartbeat: CallerHeartbeat,
): Promise<void> {
  const printRunIdentity = (): void => {
    console.error(dim(`Run ${created.taskRunId} (apo runs show ${created.taskRunId})`));
  };
  try {
    await submitCallerFailure(config.backendUrl, created.lease, {
      completion_id: completionId,
      failure_kind: "result_invalid",
      // Bounded: the backend stores this verbatim; the diagnostic is already
      // byte counts and field names.
      error_message: diagnostic.slice(0, 2_000),
    });
    printRunIdentity();
  } catch (reportError) {
    const reportMessage = reportError instanceof Error ? reportError.message : String(reportError);
    console.error(red(`Warning: failed to report result rejection to backend: ${reportMessage}`));
    // Failure finalization conflicted or went unanswered. Poll the
    // authoritative state before claiming anything: a committed result must
    // not be overwritten, and an unanswered failure must not be assumed stored.
    await heartbeat.stop();
    const verdict = await pollRunVerdict(config, created.taskRunId);
    if (verdict) {
      console.error(dim(`Result recorded: run ${created.taskRunId} is ${verdict.status}.`));
    } else {
      console.error(
        red(`Error: outcome uncertain after result rejection: ${reportMessage}`),
      );
      printRunIdentity();
    }
  }
}

/** The verdict the backend recorded for a run. `noVerdictReason` is
 * `undefined` when the backend predates the field. */
export type RecordedVerdict = {
  status: "passed" | "failed" | "error";
  noVerdictReason: "judge" | "generations" | "executor" | null | undefined;
  errorMessage: string | null;
};

/**
 * Read the run's authoritative recorded verdict — once right after a result
 * was accepted, or (issue #174) polled after a failed submission: a terminal
 * ``passed``/``failed`` verdict means the backend committed the result even
 * though the transport gave up on it. Returns null while the run is still
 * undecided. An ``error`` run landed with our result when it carries checks
 * or a result-derived no-verdict reason (#323 judge, #149 generations);
 * otherwise the result never landed.
 */
export async function pollRunVerdict(
  config: Config,
  taskRunId: string,
  attempts: number = 5,
  intervalMs: number = 2_000,
): Promise<RecordedVerdict | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const run = await apiGet<{
        status: string;
        total_checks?: number;
        no_verdict_reason?: RecordedVerdict["noVerdictReason"];
        error_message?: string | null;
      }>(
        config.backendUrl,
        `/v1/agent-task-runs/${encodeURIComponent(taskRunId)}`,
        undefined,
        config,
      );
      const recorded = (status: RecordedVerdict["status"]): RecordedVerdict => ({
        status,
        noVerdictReason: run.no_verdict_reason,
        errorMessage: run.error_message ?? null,
      });
      if (run.status === "passed" || run.status === "failed") {
        return recorded(run.status);
      }
      if (run.status === "error") {
        const landed =
          (run.total_checks ?? 0) > 0 ||
          run.no_verdict_reason === "judge" ||
          run.no_verdict_reason === "generations";
        return landed ? recorded("error") : null;
      }
    } catch {
      // An unreachable or flaky run endpoint is not evidence about the
      // result — keep polling while budget remains.
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return null;
}

function loadEnvFiles(taskDir: string): void {
  const candidates = [
    resolve(taskDir, ".env"),
    resolve(taskDir, "../../.env"),
    resolve(process.cwd(), "backend/.env"),
    resolve(process.cwd(), "apps/example-service/.env"),
    resolve(process.cwd(), ".env"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (key && !(key in process.env)) {
          process.env[key] = val;
        }
      }
    } catch {
      // skip unreadable
    }
  }
}
