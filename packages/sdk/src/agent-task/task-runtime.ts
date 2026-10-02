import { runTask } from "./run/runTask.ts";
import type { EvaluationItemResult } from "./run/types.ts";
import type { AgentTaskRunConfiguration } from "./adapter/types.ts";
import { loadTask } from "./task/loadTask.ts";
import type { JudgeConfig } from "./checks/t.ts";
import { resolveJudgeToolsFromEnv, type JudgeToolsConfig } from "./checks/mcp-tools.ts";
import { buildApoAuthHeaders } from "./auth-headers.ts";
import { createOtelAgentTaskTraceClient } from "./otel-trace-client.ts";
import type { AgentTaskTraceOptions } from "./tracing.ts";

export type AgentTaskRuntime = {
  judge?: JudgeConfig;
  judgeTools?: JudgeToolsConfig;
};

export type AgentTaskRunSummary = {
  taskDir: string;
  taskId: string;
  pass: boolean;
  /** Every failing check got no answer from the judge — see `TaskEvaluationResult.noVerdict`. */
  noVerdict?: true;
  checks: EvaluationItemResult[];
  /** Adapter that ran the task. Forwarded to the backend when recording locally. */
  adapterName?: string;
  /** Trace id this run claimed (when tracing was enabled). */
  traceRunId?: string;
  /** Deliverables the adapter produced. */
  deliverables?: Record<string, unknown>;
  /** Per-turn transcript of the run. */
  transcript?: Record<string, unknown>;
  /** adapter-reported model/effort, forwarded when recording locally. */
  runConfiguration?: AgentTaskRunConfiguration;
};

export async function loadTaskRuntime(
  _taskDir: string,
): Promise<AgentTaskRuntime> {
  return {
    judge: resolveJudgeFromEnv(),
    // Env/file layer for MCP evidence servers (APO_JUDGE_MCP) — seeds the
    // run-level config, so explicit runTask({ judgeTools }) always wins.
    judgeTools: await resolveJudgeToolsFromEnv(),
  };
}

function resolveJudgeFromEnv(): JudgeConfig | undefined {
  const openRouterModel = process.env.OPENROUTER_MODEL;
  const model = openRouterModel ?? process.env.OPENAI_MODEL;
  if (!model) return undefined;

  return {
    model,
    baseURL: openRouterModel
      ? process.env.OPENROUTER_BASE_URL
      : process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: openRouterModel
      ? process.env.OPENROUTER_API_KEY
      : process.env.OPENAI_API_KEY,
  };
}

export type RunTaskDirOptions = {
  /**
   * Receives a handle that ends the active run's root span as cancelled and
   * flushes it. Callers that can be terminated by a signal (the CLI task
   * child, `apo task run`) register it so the run's trace and linkage survive
   * their own death instead of dying with the process.
   */
  registerCancel?: (cancel: (reason?: string) => Promise<void>) => void;
};

export async function runTaskDir(
  taskDir: string,
  options?: RunTaskDirOptions,
): Promise<AgentTaskRunSummary> {
  const [loaded, runtime] = await Promise.all([
    loadTask(taskDir),
    loadTaskRuntime(taskDir),
  ]);

  // Set up OTel tracing for CLI-driven task runs.
  // The backend subprocess (runner-entry.ts) does its own setup;
  // this covers the CLI path (runAgentTaskCli → runTaskDir).
  // Falls back to noop tracing when no endpoint is configured (e.g. tests).
  const endpoint = process.env.AGENT_TASK_TRACE_ENDPOINT;
  const hasTracing = endpoint && process.env.AGENT_TASK_PROJECT;
  // When the backend pre-created the task run (external execution mode,
  // Issue #4), stamping apo.task.run.id on the root span lets the existing
  // claim machinery atomically link this trace to the run row. Mirrors
  // runner-entry.ts — never trust telemetry alone for ownership.
  const taskRunId = process.env.AGENT_TASK_RUN_ID;

  const tracing = hasTracing
    ? {
        client: createOtelAgentTaskTraceClient({
          endpoint,
          project: process.env.AGENT_TASK_PROJECT!,
          headers: buildApoAuthHeaders(),
        }),
        project: process.env.AGENT_TASK_PROJECT!,
        environment: process.env.AGENT_TASK_ENVIRONMENT ?? "default",
        ...(taskRunId ? { taskRunId } : {}),
      } as AgentTaskTraceOptions
    : undefined;

  if (tracing && options?.registerCancel) {
    options.registerCancel((reason) => tracing.client.cancelActiveRun(reason));
  }

  // Thread the already-loaded task through so runTask does not re-import the
  // eval module (Issue #7). loadTask above copied the eval to a temp file and
  // imported it once with all registries reset; a second loadTask would run
  // the eval's top level again and silently break evals whose load-time
  // behavior is not idempotent across module systems.
  const result = await runTask(taskDir, { ...runtime, tracing, loaded });

  return {
    taskDir: loaded.taskDir,
    taskId: loaded.task.id,
    pass: result.result.pass,
    ...(result.result.noVerdict ? { noVerdict: true as const } : {}),
    checks: result.result.checks,
    adapterName: loaded.adapter.name,
    traceRunId: result.traceRunId,
    deliverables: result.deliverables,
    transcript: result.transcript as unknown as Record<string, unknown>,
    runConfiguration: result.runConfiguration,
  };
}

