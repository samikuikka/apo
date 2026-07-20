import { runTask } from "./run/runTask.ts";
import type { EvaluationItemResult } from "./run/types.ts";
import { loadTask } from "./task/loadTask.ts";
import type { JudgeConfig } from "./checks/t.ts";
import { createOtelAgentTaskTraceClient } from "./otel-trace-client.ts";
import type { AgentTaskTraceOptions } from "./tracing.ts";

export type AgentTaskRuntime = {
  judge?: JudgeConfig;
};

export type AgentTaskRunSummary = {
  taskDir: string;
  taskId: string;
  pass: boolean;
  checks: EvaluationItemResult[];
  /** Adapter that ran the task. Forwarded to the backend when recording locally. */
  adapterName?: string;
  /** Trace id this run claimed (when tracing was enabled). */
  traceRunId?: string;
  /** Deliverables the adapter produced. */
  deliverables?: Record<string, unknown>;
  /** Per-turn transcript of the run. */
  transcript?: Record<string, unknown>;
};

export async function loadTaskRuntime(
  _taskDir: string,
): Promise<AgentTaskRuntime> {
  return {
    judge: resolveJudgeFromEnv(),
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

export async function runTaskDir(
  taskDir: string,
): Promise<AgentTaskRunSummary> {
  const [loaded, runtime] = await Promise.all([
    loadTask(taskDir),
    loadTaskRuntime(taskDir),
  ]);

  // Set up OTel tracing for CLI-driven task runs (SPEC-129 §7).
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
          headers: _buildAuthHeaders(),
        }),
        project: process.env.AGENT_TASK_PROJECT!,
        environment: process.env.AGENT_TASK_ENVIRONMENT ?? "default",
        ...(taskRunId ? { taskRunId } : {}),
      } as AgentTaskTraceOptions
    : undefined;

  const result = await runTask(taskDir, { ...runtime, tracing });

  return {
    taskDir: loaded.taskDir,
    taskId: loaded.task.id,
    pass: result.result.pass,
    checks: result.result.checks,
    adapterName: loaded.adapter.name,
    traceRunId: result.traceRunId,
    deliverables: result.deliverables,
    transcript: result.transcript as unknown as Record<string, unknown>,
  };
}

function _buildAuthHeaders(): Record<string, string> | undefined {
  const pk = process.env.APO_PUBLIC_KEY;
  const sk = process.env.APO_SECRET_KEY;
  if (pk && sk) {
    const creds = typeof btoa === "function"
      ? btoa(`${pk}:${sk}`)
      : Buffer.from(`${pk}:${sk}`).toString("base64");
    return { Authorization: `Basic ${creds}` };
  }
  const token = process.env.APO_AUTH_TOKEN;
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return undefined;
}
