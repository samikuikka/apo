/**
 * Standalone runner entrypoint for the agent-task runtime.
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
import { persistFileArtifacts } from "./deliverables/upload.ts";
import { writeResultAtomically } from "./runner-result.ts";

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
    ?? "deepseek/deepseek-v4.1-flash";

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

  // upload file Artifacts through the two-phase endpoint before
  // writing the result body. Only JSON Deliverables (and the manifest of
  // uploaded Artifacts) travel through stdout — never file bytes, paths, or
  // the redundant task transcript (the Trace is the conversation source).
  const recorded = taskRunId
    ? await persistFileArtifacts(result.deliverables, {
        taskRunId,
        authToken: authToken ?? "",
        baseUrl: endpoint.replace(/\/$/, ""),
      })
    : { jsonDeliverables: result.deliverables, artifactUploads: [] };

  // the result body goes to AGENT_TASK_RESULT_PATH (an atomic, bounded
  // JSON file the Bundled Executor reads) when set; stdout is human diagnostics
  // only and can never replace the file. The dev/legacy path keeps stdout so
  // `apo` CLI capture and tests keep working.
  const resultBody = JSON.stringify({
    taskId: result.task.id,
    adapterName: loaded.adapter.name,
    pass: result.result.pass,
    checks: result.result.checks,
    deliverables: recorded.jsonDeliverables,
    traceRunId: result.traceRunId ?? null,
    // the adapter's resolved model/effort. The executor parses this
    // into the typed run_configuration columns. Absent when the adapter does
    // not report configuration.
    runConfiguration: result.runConfiguration ?? null,
  });

  const resultPath = process.env.AGENT_TASK_RESULT_PATH;
  if (resultPath) {
    writeResultAtomically(resultPath, resultBody);
  } else {
    process.stdout.write(resultBody);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
