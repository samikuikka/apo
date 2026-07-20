/**
 * Standalone runner entrypoint for the agent-task runtime (SPEC-125).
 *
 * The backend launches it as ``node /app/agent-task-runtime/runner.mjs``
 * inside the task workspace. Local development can still use the dev
 * ``tsx`` path via the same env-var contract.
 */

import {
  loadTask,
  loadTaskRuntime,
  runTask,
  type AgentTaskTraceOptions,
} from "./public.ts";
import { createOtelAgentTaskTraceClient } from "./otel-trace-client.ts";

async function main(): Promise<void> {
  const taskDir = process.env.AGENT_TASK_DIR;
  const project = process.env.AGENT_TASK_PROJECT ?? "default";
  const environment = process.env.AGENT_TASK_ENVIRONMENT ?? "default";
  const endpoint =
    process.env.AGENT_TASK_TRACE_ENDPOINT ?? "http://127.0.0.1:8000";
  const authToken = process.env.APO_AUTH_TOKEN;
  const requirePersistence = process.env.AGENT_TASK_TRACE_REQUIRED === "true";
  const taskRunId = process.env.AGENT_TASK_RUN_ID;
  const runMetadata = process.env.AGENT_TASK_RUN_METADATA
    ? JSON.parse(process.env.AGENT_TASK_RUN_METADATA)
    : undefined;
  const judgeModel =
    process.env.AGENT_TASK_JUDGE_MODEL
    ?? process.env.AGENT_TASK_OPENROUTER_MODEL
    ?? "google/gemini-2.5-flash";

  if (!taskDir) {
    throw new Error("AGENT_TASK_DIR is required");
  }

  const [loaded, runtime] = await Promise.all([
    loadTask(taskDir),
    loadTaskRuntime(taskDir),
  ]);

  const tracing = {
    client: createOtelAgentTaskTraceClient({
      endpoint,
      project,
      authToken,
      requirePersistence,
    }),
    project,
    environment,
    runMetadata,
    ...(taskRunId ? { taskRunId } : {}),
  } as AgentTaskTraceOptions;

  // Thread the already-loaded task through so runTask does not re-import the
  // eval module (Issue #7). loadTask above copied the eval to a temp file and
  // imported it once with all registries reset; a second loadTask would run
  // the eval's top level again and silently break evals whose load-time
  // behavior is not idempotent across module systems.
  const result = await runTask(taskDir, {
    ...runtime,
    tracing,
    judge: { model: judgeModel },
    loaded,
  });

  process.stdout.write(
    JSON.stringify({
      taskId: result.task.id,
      adapterName: loaded.adapter.name,
      pass: result.result.pass,
      checks: result.result.checks,
      transcript: result.transcript,
      deliverables: result.deliverables,
      traceRunId: result.traceRunId ?? null,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
