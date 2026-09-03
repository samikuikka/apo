import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { getBoolFlag, parseArgs, requirePositional } from "../lib/args.ts";
import { resolveConfig, type Config } from "../lib/config.ts";
import { apiGet, isBackendReachable } from "../lib/api.ts";
import { discoverTaskMeta, findTaskMetaById } from "../lib/task-meta.ts";
import { bold, dim, formatJson, passFail, red } from "../lib/format.ts";
import type { CheckResult } from "../lib/agent-task-types.ts";
import { formatChecks, NO_CHECKS_REGISTERED_MESSAGE } from "../lib/checks-format.ts";
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
} from "../lib/caller-execution.ts";

type LocalRunSummary = {
  taskId: string;
  pass: boolean;
  checks: CheckResult[];
  adapterName?: string;
  traceRunId?: string;
  deliverables?: Record<string, unknown>;
  transcript?: Record<string, unknown>;
  runConfiguration?: { model: string; effort?: string };
};

export async function run(argv: string[]): Promise<number> {
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
    return runLocally(config, resolved.taskDir);
  }

  // Default recorded path: caller create-and-claim.
  if (config.projectId && config.apiKey) {
    if (await isBackendReachable(config.backendUrl)) {
      return runCallerRecorded(config, resolved);
    }
    console.error(`${red("error:")} backend unreachable; configured recording failed (use --no-record to run unrecorded)`);
    return 2;
  }

  // No project or credential configured → run unrecorded with a notice.
  console.error(`${dim("note:")} run is not being recorded (no project or credential configured)`);
  return runLocally(config, resolved.taskDir);
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

async function runLocally(config: Config, taskDir: string): Promise<number> {
  loadEnvFiles(taskDir);
  const { runTaskDir } = await import("@apo-ai/sdk/agent-task");

  let summary: LocalRunSummary;
  try {
    console.log(dim(`Running task from ${taskDir}...`));
    summary = await runTaskDir(taskDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(`Error: ${message}`));
    return 2;
  }

  if (config.json) {
    console.log(formatJson(summary));
  } else {
    printLocalRunSummary(summary);
  }

  return summary.pass ? 0 : 1;
}

/**
 * recorded caller execution. Hashes the real caller workspace, creates
 * + claims one Attempt, /start, runs the SDK Task locally with the Attempt JWT
 * in the child env (never the Project API key), heartbeats, and submits the
 * result/failure through the scoped protocol.
 */
async function runCallerRecorded(config: Config, resolved: ResolvedTask): Promise<number> {
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
  process.env.AGENT_TASK_TRACE_ENDPOINT = config.backendUrl.replace(/\/$/, "");
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

  // 4. Import the SDK BEFORE /start (issue #108). Startup failures (package
  // not found, module-resolution errors) must happen pre-start so the lease
  // reaper requeues the attempt instead of marking it LOST with the misleading
  // "after task code started" message. The trace env vars are already set
  // (step 3), and the SDK reads them at import time — no /start dependency.
  let runTaskDirImpl: (taskDir: string) => Promise<unknown>;
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
    delete process.env.APO_AUTH_TOKEN;
    return 2;
  }

  // 5. /start (now after a successful SDK import — startup failures are pre-start).
  try {
    await startCallerAttempt(backendUrl, created.lease);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(`Error: /start failed: ${message}`));
    return 2;
  }

  // 6. Run the Task locally with a background heartbeat.
  const heartbeat = new CallerHeartbeat(backendUrl, created.lease, () => {
    console.error(red("Warning: lease reported stale/cancelled"));
  });
  heartbeat.start("running");
  loadEnvFiles(taskDir);

  const completionId = `${created.lease.attemptId}-${created.lease.generation}`;
  let exitCode = 0;
  let resultStarted = false;
  let artifactPhase = false;
  // Visible to the catch block: when the result POST fails at the transport
  // level (Issue #174) the run may still have committed, and the recovery
  // path needs the summary to render the verdict it confirmed server-side.
  let summary: LocalRunSummary | null = null;
  let jsonDeliverables: Record<string, unknown> = {};
  try {
    summary = await runTaskDirImpl(taskDir) as LocalRunSummary;

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
    const checksForSubmission = compactChecksImpl
      ? compactChecksImpl(summary.checks).checks
      : summary.checks;
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
    warnIfResultBodyLarge(resultBody);
    await submitCallerResult(backendUrl, created.lease, resultBody);
    // render the result so the CLI shows PASS/FAIL + checks,
    // just like the local and backend paths it replaced.
    exitCode = renderRecordedResult(config, summary, jsonDeliverables, created.taskRunId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (resultStarted) {
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
        console.error(dim(`Result recorded: run ${created.taskRunId} is ${verdict}.`));
        exitCode = renderRecordedResult(config, summary, jsonDeliverables, created.taskRunId);
      } else {
        console.error(red(`Error: result submission outcome unknown: ${message}`));
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
  }
  return exitCode;
}

function printLocalRunSummary(summary: LocalRunSummary): void {
  console.log("");
  console.log(`${passFail(summary.pass)} ${bold(summary.taskId)}`);

  if (summary.checks.length > 0) {
    console.log(bold("  Checks:"));
    console.log(formatChecks(summary.checks));
  } else if (!summary.pass) {
    // Issue #8: a failed run with zero checks is almost always a silent
    // registration bug (e.g. a double-import that wiped the check registry).
    // Don't leave the user staring at a bare FAIL — say what went wrong.
    console.log(`  ${NO_CHECKS_REGISTERED_MESSAGE}`);
  }
}

/** Render a recorded run's verdict and hand over its exact identity. */
function renderRecordedResult(
  config: Config,
  summary: LocalRunSummary,
  jsonDeliverables: Record<string, unknown>,
  taskRunId: string,
): number {
  if (config.json) {
    console.log(JSON.stringify({ ...summary, deliverables: jsonDeliverables }));
  } else {
    printLocalRunSummary(summary);
    // Hand over the exact recorded identity — onboarding copy
    // must never rely on "latest run" lookup.
    console.log(`\nRun:     ${bold(taskRunId)}`);
    console.log(`Inspect: ${dim(`apo runs show ${taskRunId}`)}`);
  }
  return summary.pass ? 0 : 1;
}

/**
 * Issue #175's submission guard: compaction already removes the duplicated
 * judged subjects, so a body this large is transcript/deliverable content the
 * server genuinely stores. Warn (never refuse — refusing loses runs, the
 * lesson of #174) so the case is visible instead of dying as a timeout.
 */
const RESULT_BODY_WARN_BYTES = 20 * 1024 * 1024;

/** Exported for tests: the 20 MB submission-size guard (issue #175). */
export function warnIfResultBodyLarge(body: CallerResultBody): void {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(body));
  } catch {
    return;
  }
  if (bytes <= RESULT_BODY_WARN_BYTES) return;
  console.error(
    `Warning: result submission body is ${(bytes / (1024 * 1024)).toFixed(1)} MB (> 20 MB). ` +
      "Check values are already compacted to markers; the remainder is " +
      "transcript/deliverable content. Very large bodies risk upload timeouts.",
  );
}

/**
 * Issue #174: after a failed result submission, poll the run's authoritative
 * state. A terminal ``passed``/``failed`` verdict means the backend committed
 * the result even though the transport gave up on it — the run is safe and
 * the CLI can report the verdict instead of exiting "outcome unknown".
 * Returns the terminal status, or null while the run is still undecided.
 */
export async function pollRunVerdict(
  config: Config,
  taskRunId: string,
  attempts: number = 5,
  intervalMs: number = 2_000,
): Promise<"passed" | "failed" | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const run = await apiGet<{ status: string }>(
        config.backendUrl,
        `/v1/agent-task-runs/${encodeURIComponent(taskRunId)}`,
        undefined,
        config,
      );
      if (run.status === "passed" || run.status === "failed") {
        return run.status;
      }
      if (run.status === "error") {
        // Terminal without our verdict — the result never landed.
        return null;
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
