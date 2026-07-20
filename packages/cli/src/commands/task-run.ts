import { existsSync, readFileSync } from "fs";
import { hostname } from "os";
import { resolve } from "path";
import { getBoolFlag, parseArgs, requirePositional } from "../lib/args.ts";
import { resolveConfig, type Config } from "../lib/config.ts";
import { apiGet, apiPost, isBackendReachable } from "../lib/api.ts";
import { discoverTaskMeta } from "../lib/task-meta.ts";
import { bold, dim, formatJson, formatTime, passFail, formatTrigger, red } from "../lib/format.ts";
import type { CheckResult } from "../lib/agent-task-types.ts";
import { formatChecks } from "../lib/checks-format.ts";

type LocalRunSummary = {
  taskId: string;
  pass: boolean;
  checks: CheckResult[];
  adapterName?: string;
  traceRunId?: string;
  deliverables?: Record<string, unknown>;
  transcript?: Record<string, unknown>;
};

type ExternalTaskRun = {
  id: string;
  task_id: string;
  task_path: string;
  status: string;
  started_at: string | null;
  trace_token: string;
};

type ExternalBatchDetail = {
  id: string;
  project: string;
  status: string;
  task_runs: ExternalTaskRun[];
};

type TaskRunTrigger = {
  source: string | null;
  actor: string | null;
  hostname: string | null;
  user_agent: string | null;
  entrypoint: string | null;
  initiated_at: string | null;
  ci_system: string | null;
  ci_run_id: string | null;
  ci_run_url: string | null;
  repository: string | null;
  branch: string | null;
  commit_sha: string | null;
  pr_number: string | null;
};

type BatchDetail = {
  id: string;
  status: string;
  task_runs: TaskRunSummary[];
};

type TaskRunSummary = {
  id: string;
  batch_run_id: string;
  task_id: string;
  task_path: string;
  adapter_name: string | null;
  status: string;
  pass_result: boolean | null;
  started_at: string | null;
  completed_at: string | null;
  trace_run_id: string | null;
  error_message: string | null;
  total_cost: number | null;
  trigger: TaskRunTrigger | null;
};

type TaskRunDetail = TaskRunSummary & {
  total_tokens?: number | null;
  checks_json: CheckResult[] | null;
  transcript_json: Record<string, unknown> | null;
  deliverables_json: Record<string, unknown> | null;
};

const TASK_RUN_POLL_INTERVAL_MS = 1_000;
const TASK_RUN_MAX_WAIT_MS = 150_000;

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const taskRef = requirePositional(positional, 0, "task-id | path");

  const forceLocal = getBoolFlag(flags, "local");
  if (forceLocal) {
    if (config.projectId && await isBackendReachable(config.backendUrl)) {
      return runLocallyRecorded(config, resolveProjectTaskSelection(taskRef, config.taskRoot));
    }
    // Backend not reachable — degrade to today's unrecorded local run.
    console.warn(
      dim("--local: backend not reachable or no project set; running unrecorded."),
    );
    const taskDir = resolveTaskDir(taskRef, config.taskRoot);
    if (!taskDir) {
      console.error(`Task not found: ${taskRef}`);
      return 2;
    }
    return runLocally(config, taskDir);
  }

  if (config.projectId && await isBackendReachable(config.backendUrl)) {
    return runViaBackend(config, resolveProjectTaskSelection(taskRef, config.taskRoot));
  }

  const taskDir = resolveTaskDir(taskRef, config.taskRoot);
  if (!taskDir) {
    console.error(`Task not found: ${taskRef}`);
    return 2;
  }
  return runLocally(config, taskDir);
}

function resolveCiTrigger(flags: Record<string, string | boolean>): Record<string, unknown> | null {
  const ciFlag = flags.ci === true || process.env.CI === "true";
  if (!ciFlag) return null;

  return {
    source: "ci",
    actor: resolveFlagOrEnv(flags, "ci-actor", "APO_CI_ACTOR") ?? "ci",
    hostname: resolveFlagOrEnv(flags, "ci-hostname", "APO_CI_HOSTNAME") ?? null,
    entrypoint: "apo task run --ci",
    initiated_at: new Date().toISOString(),
    ci_system: resolveFlagOrEnv(flags, "ci-system", "APO_CI_SYSTEM") ?? detectCiSystem(),
    ci_run_id: resolveFlagOrEnv(flags, "ci-run-id", "APO_CI_RUN_ID") ?? process.env.GITHUB_RUN_ID ?? null,
    ci_run_url: resolveFlagOrEnv(flags, "ci-run-url", "APO_CI_RUN_URL") ?? null,
    repository: resolveFlagOrEnv(flags, "repo", "APO_GITHUB_REPO") ?? process.env.GITHUB_REPOSITORY ?? null,
    branch: resolveFlagOrEnv(flags, "branch", "APO_GITHUB_BRANCH") ?? process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? null,
    commit_sha: resolveFlagOrEnv(flags, "sha", "APO_GITHUB_SHA") ?? process.env.GITHUB_SHA ?? null,
    pr_number: resolveFlagOrEnv(flags, "pr", "APO_GITHUB_PR") ?? process.env.GITHUB_EVENT_NUMBER ?? null,
  };
}

function detectCiSystem(): string | null {
  if (process.env.GITHUB_ACTIONS === "true") return "github-actions";
  if (process.env.GITLAB_CI === "true") return "gitlab-ci";
  if (process.env.CIRCLECI === "true") return "circleci";
  if (process.env.JENKINS_URL) return "jenkins";
  return null;
}

function resolveFlagOrEnv(
  flags: Record<string, string | boolean>,
  flagName: string,
  envVar: string,
): string | null {
  const flagVal = flags[flagName];
  if (typeof flagVal === "string" && flagVal) return flagVal;
  return process.env[envVar] ?? null;
}

function resolveTaskDir(
  ref: string,
  taskRoot: string,
): string | null {
  const asPath = resolve(ref);
  if (existsSync(asPath)) {
    return asPath;
  }

  const tasks = discoverTaskMeta(taskRoot);
  const match = tasks.find((t) => t.id === ref);
  return match?.path ?? null;
}

async function runLocally(config: Config, taskDir: string): Promise<number> {
  loadEnvFiles(taskDir);
  const { runTaskDir } = await import("@apo/sdk/agent-task");

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

async function runLocallyRecorded(config: Config, taskRef: string): Promise<number> {
  // Issue #4: run on the dev machine (where credentials / VPC / stage live)
  // but still create a backend task run + link the trace, so the dashboard
  // records history, trends, and trace drill-down.
  const ciTrigger = resolveCiTrigger(config._rawFlags);
  const trigger = ciTrigger ?? {
    source: "cli-local",
    actor: config.actor ?? process.env.USER ?? process.env.LOGNAME ?? null,
    hostname: hostname(),
    entrypoint: "apo task run --local",
    initiated_at: new Date().toISOString(),
  };

  const createBody = {
    project: config.projectId,
    selection_type: "task",
    task_paths: [taskRef],
    task_root: resolve(config.taskRoot),
    run_metadata: { trigger },
  };

  let batch: ExternalBatchDetail;
  try {
    batch = await apiPost<ExternalBatchDetail>(
      config.backendUrl,
      "/v1/agent-task-batch-runs/external",
      createBody,
      config,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(message.startsWith("Backend error") ? message : `Cannot connect to backend at ${config.backendUrl}`));
    if (!message.startsWith("Backend error")) {
      console.error(dim(message));
    }
    return 2;
  }

  const externalRun = batch.task_runs[0];
  if (!externalRun) {
    console.error(red(`Backend created batch ${batch.id} with no task runs`));
    return 2;
  }

  // Thread the minted token + run id to the SDK so the trace claims the run
  // via the existing SPEC-128/129 path (stamps apo.task.run.id on the root
  // span; token sub authorizes the atomic link).
  process.env.AGENT_TASK_TRACE_ENDPOINT = config.backendUrl;
  process.env.AGENT_TASK_PROJECT = config.projectId!;
  process.env.AGENT_TASK_RUN_ID = externalRun.id;
  process.env.AGENT_TASK_TRACE_REQUIRED = "true";
  process.env.APO_AUTH_TOKEN = externalRun.trace_token;

  const taskDir = resolveTaskDir(taskRef, config.taskRoot) ?? taskRef;
  loadEnvFiles(taskDir);

  const { runTaskDir } = await import("@apo/sdk/agent-task");
  let summary: LocalRunSummary;
  try {
    console.log(dim(`Running task locally from ${taskDir} (run ${externalRun.id})...`));
    summary = await runTaskDir(taskDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(`Error: ${message}`));
    // Report the failure so the dashboard row reflects reality, not a hang.
    await reportResultSafely(config, externalRun.id, {
      pass_result: false,
      error_message: message,
    });
    return 2;
  }

  const reported = await reportResultSafely(config, externalRun.id, {
    pass_result: summary.pass,
    adapter_name: summary.adapterName,
    trace_run_id: summary.traceRunId,
    checks: summary.checks,
    transcript: summary.transcript,
    deliverables: summary.deliverables,
  });

  if (config.json) {
    console.log(formatJson(reported ?? summary));
  } else {
    printLocalRecordedSummary(externalRun, batch, summary, reported);
  }

  return summary.pass ? 0 : 1;
}

async function reportResultSafely(
  config: Config,
  taskRunId: string,
  body: {
    pass_result: boolean;
    adapter_name?: string;
    trace_run_id?: string;
    checks?: CheckResult[];
    transcript?: Record<string, unknown>;
    deliverables?: Record<string, unknown>;
    error_message?: string;
  },
): Promise<TaskRunSummary | null> {
  try {
    return await apiPost<TaskRunSummary>(
      config.backendUrl,
      `/v1/agent-task-runs/${taskRunId}/result`,
      body,
      config,
    );
  } catch (error) {
    // The local run already succeeded/failed — a reporting failure must not
    // mask that. Surface it but keep the verdict from the run itself.
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(`Failed to report result for ${taskRunId}: ${message}`));
    return null;
  }
}

function printLocalRecordedSummary(
  externalRun: ExternalTaskRun,
  batch: ExternalBatchDetail,
  summary: LocalRunSummary,
  reported: TaskRunSummary | null,
): void {
  console.log("");
  console.log(`${passFail(summary.pass)} ${bold(summary.taskId)}`);
  console.log(`  Run:       ${externalRun.id} ${dim("(apo runs show " + externalRun.id + ")")}`);
  console.log(`  Batch:     ${batch.id} ${dim("(apo batch show " + batch.id + ")")}`);
  if (reported?.trace_run_id ?? summary.traceRunId) {
    console.log(`  Trace:     ${reported?.trace_run_id ?? summary.traceRunId}`);
  }
  if (summary.checks.length > 0) {
    console.log(bold("  Checks:"));
    console.log(formatChecks(summary.checks));
  }
}

async function runViaBackend(config: Config, taskDir: string): Promise<number> {
  const ciTrigger = resolveCiTrigger(config._rawFlags);
  const trigger = ciTrigger ?? {
    source: "cli",
    actor: config.actor ?? process.env.USER ?? process.env.LOGNAME ?? null,
    hostname: hostname(),
    entrypoint: "apo task run",
    initiated_at: new Date().toISOString(),
  };

  const body = {
    project: config.projectId,
    selection_type: "task",
    task_paths: [taskDir],
    task_root: resolve(config.taskRoot),
    run_metadata: { trigger },
  };

  let batch: BatchDetail;
  try {
    batch = await apiPost<BatchDetail>(
      config.backendUrl,
      "/v1/agent-task-batch-runs",
      body,
      config,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(message.startsWith("Backend error") ? message : `Cannot connect to backend at ${config.backendUrl}`));
    if (!message.startsWith("Backend error")) {
      console.error(dim(message));
    }
    return 2;
  }

  const taskRun = await waitForTaskRun(config, batch);
  if (!taskRun) {
    console.error(red(`Timed out waiting for batch ${batch.id} to finish`));
    return 2;
  }

  if (config.json) {
    console.log(formatJson(taskRun));
  } else {
    printTaskRunDetail(taskRun);
    console.log(dim(`\n  Inspect: apo runs show ${taskRun.id}`));
  }

  if (config.ci) {
    if (taskRun.pass_result === true) return 0;
    if (taskRun.pass_result === false) return 1;
    return 2;
  }

  return taskRun.pass_result === false ? 1 : taskRun.status === "passed" ? 0 : 2;
}

function resolveProjectTaskSelection(ref: string, taskRoot: string): string {
  const asPath = resolve(ref);
  if (!existsSync(asPath)) {
    return ref;
  }

  const tasks = discoverTaskMeta(taskRoot);
  const match = tasks.find((task) => resolve(task.path) === asPath);
  return match?.id ?? ref;
}

async function waitForTaskRun(
  config: Config,
  initialBatch: BatchDetail,
): Promise<TaskRunDetail | null> {
  let batch = initialBatch;

  const maxAttempts = Math.ceil(TASK_RUN_MAX_WAIT_MS / TASK_RUN_POLL_INTERVAL_MS);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const runSummary = batch.task_runs[0];
    if (runSummary && isTerminalStatus(runSummary.status)) {
      return apiGet<TaskRunDetail>(
        config.backendUrl,
        `/v1/agent-task-runs/${runSummary.id}`,
        undefined,
        config,
      );
    }

    await sleep(TASK_RUN_POLL_INTERVAL_MS);
    batch = await apiGet<BatchDetail>(
      config.backendUrl,
      `/v1/agent-task-batch-runs/${batch.id}`,
      undefined,
      config,
    );
  }

  return null;
}

function isTerminalStatus(status: string): boolean {
  return status === "passed" || status === "failed" || status === "error";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function printLocalRunSummary(summary: LocalRunSummary): void {
  console.log("");
  console.log(`${passFail(summary.pass)} ${bold(summary.taskId)}`);

  if (summary.checks.length > 0) {
    console.log(bold("  Checks:"));
    console.log(formatChecks(summary.checks));
  }
}

function printTaskRunDetail(run: TaskRunDetail): void {
  console.log(bold(`Run: ${run.id}`));
  console.log(`  Task:      ${run.task_id}`);
  if (run.batch_run_id) {
    console.log(`  Batch:     ${run.batch_run_id} ${dim("(apo batch show " + run.batch_run_id + ")")}`);
  }
  console.log(`  Adapter:   ${run.adapter_name ?? "-"}`);
  console.log(`  Status:    ${run.status}`);
  console.log(
    `  Result:    ${run.pass_result === null ? "-" : passFail(run.pass_result)}`,
  );
  console.log(`  Started:   ${run.started_at ? formatTime(run.started_at) : "-"}`);
  if (run.completed_at) {
    console.log(`  Completed: ${formatTime(run.completed_at)}`);
  }
  if (run.total_cost !== null) {
    console.log(`  Cost:      $${run.total_cost.toFixed(6)}`);
  }
  if (run.total_tokens != null) {
    console.log(`  Tokens:    ${run.total_tokens.toLocaleString()}`);
  }
  console.log(`  Source:    ${formatTriggerOpt(run.trigger)}`);
  if (run.trace_run_id) {
    console.log(`  Trace:     ${run.trace_run_id}`);
  }
  if (run.error_message) {
    console.log(`  Error:     ${run.error_message}`);
  }

  if (run.checks_json?.length) {
    console.log(bold("  Checks:"));
    console.log(formatChecks(run.checks_json));
  }
}

function formatTriggerOpt(trigger: TaskRunTrigger | null): string {
  if (!trigger) {
    return "-";
  }

  return formatTrigger({
    source: trigger.source,
    actor: trigger.actor,
    hostname: trigger.hostname,
    entrypoint: trigger.entrypoint,
    repository: trigger.repository,
    branch: trigger.branch,
    commit_sha: trigger.commit_sha,
    pr_number: trigger.pr_number,
  });
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
