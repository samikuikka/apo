import type {
  TaskRunResult,
  EvaluationItemResult,
  TaskTranscriptTurn,
} from "./types.ts";
import type { AdapterRuntimeState, AdapterSession } from "../adapter/types.ts";
import { loadTask } from "../task/loadTask.ts";
import {
  getTaskTurn,
  resetTaskTurn,
  resolveTurn,
  type TurnRecord,
} from "../turn.ts";
import { TaskFiles } from "../task/TaskFiles.ts";
import { validateDeliverables } from "../deliverables/validate.ts";
import {
  loadAndRunFlowChecks,
  loadChecksModule,
  proxyBrokenDeliverables,
  resetFlowChecks,
  runTraceChecks,
} from "../checks/flow-runner.ts";
import { createProjectionTee } from "../trace-projection/projection-tee.ts";
import { readTaskRunProjection } from "../trace-projection/remote-capture.ts";
import type { JudgeConfig } from "../checks/t.ts";
import { APO_TASK_ID, APO_TASK_RUN_ID } from "../../semconv.ts";
import { aggregateResult } from "./aggregate.ts";
import type { AgentTaskTraceContext, AgentTaskTraceOptions } from "../tracing.ts";
import { createNoopAgentTaskTraceContext } from "../tracing.ts";
import type { LoadedTask } from "../task/loadTask.ts";
import { withApoRun } from "../integrations/run-context.ts";

export type RunTaskOptions = {
  maxTurnsOverride?: number;
  tracing?: AgentTaskTraceOptions;
  /** LLM judge model config for `t.judge(...)` calls in the task checks. */
  judge?: JudgeConfig;
  onTurn?: (
    turnNumber: number,
    userAction: TaskTranscriptTurn["userAction"],
    agentResponse: unknown,
  ) => void;
};

export async function runTask(
  taskDir: string,
  options?: RunTaskOptions,
): Promise<TaskRunResult> {
  const loaded = await loadTask(taskDir);
  const trace = options?.tracing;

  if (!trace) {
    // No tracing — run everything in one pass (no two-phase split needed;
    // there's no trace to contaminate).
    return executeLoadedTask(
      loaded,
      options,
      createNoopAgentTaskTraceContext(),
      undefined,
    );
  }

  // SPEC-130 two-phase split: Phase 1 (capture) runs inside the traceRun
  // callback; Phase 2 (evaluate) runs AFTER the root span ends and the trace
  // flushes, so checks/deliverable-validation cannot contaminate the trace.
  const phase1 = await trace.client.traceRun(
    buildTraceRunOptions(loaded, trace),
    async (traceContext) => captureExecution(loaded, options, traceContext),
  );

  // SPEC-130 Track C: when this run is backend-launched (has a taskRunId),
  // read the canonical projection snapshot back from the backend instead of
  // the local tee. The backend's projection is the single source of truth —
  // it includes spans the subprocess exported natively over OTLP (which the
  // in-process tee can never see, since they're created in another process).
  // Falls back to the local snapshot on any failure (offline runs, unreachable
  // backend, projection timeout) so evaluation still runs.
  const canonical = await readCanonicalSnapshot(trace);
  if (canonical) phase1.snapshot = canonical;

  // Phase 2: evaluate against the frozen snapshot. The trace is now closed.
  return evaluate(loaded, options, phase1);
}

/**
 * Read the canonical projection snapshot from the backend (Track C).
 *
 * Returns `null` when there's nothing to read (no taskRunId = offline/local
 * run) or when the read fails for any reason — the caller falls back to the
 * local tee snapshot in that case. Errors are logged but never thrown: a
 * projection read problem must not fail the task run.
 */
async function readCanonicalSnapshot(
  trace: AgentTaskTraceOptions,
): Promise<CapturedExecution["snapshot"] | null> {
  if (!trace.taskRunId) return null; // offline/local run — no backend read
  const endpoint = process.env.AGENT_TASK_TRACE_ENDPOINT;
  const authToken = process.env.APO_AUTH_TOKEN;
  if (!endpoint || !authToken) return null;
  try {
    return await readTaskRunProjection({
      endpoint,
      authToken,
      taskRunId: trace.taskRunId,
    });
  } catch (error) {
    console.error(
      "[AgentTask] Backend projection read failed, using local snapshot:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/** Phase 1 result: what capture produced, passed to Phase 2 evaluation. */
interface CapturedExecution {
  traceRunId: string | undefined;
  collected: Record<string, unknown>;
  transcriptTurns: TaskTranscriptTurn[];
  /** The frozen projection snapshot Phase 2 evaluates against. */
  snapshot: import("../trace-projection/types.ts").TraceProjectionSnapshot;
}

async function executeLoadedTask(
  loaded: LoadedTask,
  options: RunTaskOptions | undefined,
  rawTrace: AgentTaskTraceContext,
  traceRunId: string | undefined,
): Promise<TaskRunResult> {
  const {
    task,
    adapter,
    taskDir: absoluteDir,
    files,
    checksPath,
    inlineChecks,
    moduleUrl,
    evalFileName,
  } = loaded;
  const taskFiles = new TaskFiles(files);
  // Tee the trace so the run's tool/agent/message spans also build the
  // projection snapshot that checks read. `trace` below is the wrapped context.
  const tee = createProjectionTee(rawTrace);
  const { trace, getSnapshot } = { trace: tee.trace, getSnapshot: () => tee.getSnapshot() };

  // Establish the run on AsyncLocalStorage so the OTel SpanProcessor
  // (if registered) can route GenAI spans to this run's trace context.
  return withApoRun(
    { trace, parentSpanId: rawTrace.rootSpanId, taskId: task.id },
    async () => {
      // All the local state that the previous body used, now inside the ALS scope
      return executeRunBody();
    },
  );

  async function executeRunBody(): Promise<TaskRunResult> {
    let state: AdapterRuntimeState | undefined;
    let session: AdapterSession | undefined;
    const transcriptTurns: TaskTranscriptTurn[] = [];

  try {
    await trace.step(
      {
        step_name: "task.load",
        input: { taskId: task.id, taskDir: absoluteDir },
        metadata: {
          taskId: task.id,
          taskDir: absoluteDir,
          fileCount: files.length,
          hasChecks: inlineChecks || checksPath !== null,
        },
        summarize: () => ({
          taskId: task.id,
          adapterName: adapter.name,
        }),
      },
      async () => loaded,
    );

    if (adapter.initialize) {
      const initState = await trace.step(
        {
          step_name: "adapter.initialize",
          input: { adapterName: adapter.name },
          metadata: { adapterName: adapter.name },
          summarize: (result) => ({
            initialized: true,
            stateKeys:
              result && typeof result === "object"
                ? Object.keys(result as Record<string, unknown>)
                : [],
          }),
        },
        async () =>
          adapter.initialize?.({
            task,
            taskDir: absoluteDir,
            files,
            trace,
          }),
      );
      state = initState ?? undefined;
    }

    session = await trace.step(
      {
        step_name: "adapter.open-session",
        input: { adapterName: adapter.name, hasState: state !== undefined },
        metadata: { adapterName: adapter.name },
        summarize: () => ({ sessionOpened: true }),
      },
      async () =>
        adapter.startSession({
          task,
          taskDir: absoluteDir,
          files,
          state,
          trace,
        }),
    );

    // Legacy two-file tasks register turn() from checks.ts. Single-file tasks
    // already registered it while loadTask imported the .eval.ts file.
    if (!inlineChecks && checksPath) {
      resetTaskTurn();
      resetFlowChecks();
      await loadChecksModule(checksPath);
    }

    const taskTurn = getTaskTurn();
    resetTaskTurn();
    const turnFn = resolveTurn(adapter.turn, taskTurn);

    if (turnFn) {
      const turnTranscript: TurnRecord[] = [];
      // Precedence: explicit run override → task config → default 10.
      const maxTurns = options?.maxTurnsOverride ?? task.maxTurns ?? 10;

      for (let turnNum = 1; turnNum <= maxTurns; turnNum++) {
        const userTurn = await turnFn({ files: taskFiles, transcript: turnTranscript });
        if (userTurn === null || userTurn === undefined) break;

        const result = await trace.step(
          {
            step_name: "task.turn",
            metadata: { turnNumber: turnNum },
          },
          async (spanId) => {
            if (!session) throw new Error("Session not created");
            return session.sendUserTurn(userTurn, {
              trace,
              turnNumber: turnNum,
              parentSpanId: spanId,
            });
          },
        );

        turnTranscript.push({
          turnNumber: turnNum,
          input: userTurn,
          output: result.response,
        });
        transcriptTurns.push({
          turnNumber: turnNum,
          userAction: userTurn,
          agentResponse: result.response,
        });
        options?.onTurn?.(turnNum, userTurn, result.response);
      }
    }

    const collected = await trace.step(
      {
        step_name: "adapter.collect-deliverables",
        input: { adapterName: adapter.name, expectedDeliverables: task.deliverables },
        metadata: { adapterName: adapter.name },
        summarize: (result) => {
          const keys =
            result && typeof result === "object"
              ? Object.keys(result as Record<string, unknown>)
              : [];
          return { deliverableCount: keys.length, deliverableNames: keys };
        },
      },
      async () => {
        if (!session) {
          throw new Error("Adapter session was not created");
        }

        return adapter.collectDeliverables({
          task,
          taskDir: absoluteDir,
          files,
          state,
          session,
          trace,
        });
      },
    );

    const validationResults = await trace.step(
      {
        step_name: "deliverables.validate",
        input: { deliverableNames: task.deliverables },
        summarize: (result) => {
          const r = result as ReturnType<typeof validateDeliverables>;
          const passCount = r.results.filter((x) => x.pass).length;
          const broken = Object.keys(r.brokenDeliverables);
          return {
            total: r.results.length,
            passCount,
            failCount: r.results.length - passCount,
            brokenDeliverableCount: broken.length,
            brokenDeliverables: broken,
          };
        },
      },
      async () => validateDeliverables(task, collected, adapter.deliverables),
    );

    const checksResults = await trace.step(
      {
        step_name: "checks.run",
        input: { sourceFile: inlineChecks ? evalFileName : checksPath },
        metadata: { sourceFile: inlineChecks ? evalFileName : checksPath },
        summarize: (result) =>
          summarizeEvaluationResults(result as EvaluationItemResult[]),
      },
      async () => {
        if (!inlineChecks) {
          return loadAndRunFlowChecks(
            checksPath,
            {
              snapshot: getSnapshot(),
              deliverables: collected,
              files,
              task,
              judgeConfig: options?.judge,
            },
            validationResults.brokenDeliverables,
          );
        }
        return runTraceChecks({
          snapshot: getSnapshot(),
          deliverables: proxyBrokenDeliverables(
            collected,
            validationResults.brokenDeliverables,
          ),
          files,
          task,
          judgeConfig: options?.judge,
          moduleUrl,
          displayFile: evalFileName,
        });
      },
    );

    const result = aggregateResult(checksResults);

    return {
      task,
      taskDir: absoluteDir,
      files,
      traceRunId,
      result,
      deliverables: collected,
      transcript: { turns: transcriptTurns },
    };
  } finally {
    if (adapter.cleanup) {
      try {
        await trace.step(
          {
            step_name: "adapter.cleanup",
            input: { adapterName: adapter.name },
            metadata: { adapterName: adapter.name },
            summarize: () => ({ cleaned: true }),
          },
          async () =>
            adapter.cleanup?.({
              task,
              taskDir: absoluteDir,
              files,
              state,
              session,
              trace,
            }),
        );
      } catch (error) {
        console.error(
          "[AgentTask] Cleanup failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (session?.close) {
      try {
        await session.close();
      } catch {
        // ignore close errors
      }
    }
  }
  } // end executeRunBody
}

/**
 * Phase 1 (SPEC-130 two-phase split): capture the execution inside the trace.
 * Runs adapter init → session → turns → deliverable collection → cleanup.
 * Excludes deliverable validation and checks — those run in Phase 2, after the
 * root span ends and the trace flushes, so they cannot contaminate the trace.
 */
async function captureExecution(
  loaded: LoadedTask,
  options: RunTaskOptions | undefined,
  rawTrace: AgentTaskTraceContext,
): Promise<CapturedExecution> {
  const {
    task,
    adapter,
    taskDir: absoluteDir,
    files,
    checksPath,
    inlineChecks,
  } = loaded;
  const taskFiles = new TaskFiles(files);
  const tee = createProjectionTee(rawTrace);
  const trace = tee.trace;

  return withApoRun(
    { trace, parentSpanId: rawTrace.rootSpanId, taskId: task.id },
    async () => {
      let state: AdapterRuntimeState | undefined;
      let session: AdapterSession | undefined;
      const transcriptTurns: TaskTranscriptTurn[] = [];

      try {
        await trace.step(
          { step_name: "task.load", input: { taskId: task.id, taskDir: absoluteDir }, metadata: { taskId: task.id, taskDir: absoluteDir, fileCount: files.length, hasChecks: inlineChecks || checksPath !== null }, summarize: () => ({ taskId: task.id, adapterName: adapter.name }) },
          async () => loaded,
        );

        if (adapter.initialize) {
          const initState = await trace.step(
            { step_name: "adapter.initialize", input: { adapterName: adapter.name }, metadata: { adapterName: adapter.name }, summarize: (result) => ({ initialized: true, stateKeys: result && typeof result === "object" ? Object.keys(result as Record<string, unknown>) : [] }) },
            async () => adapter.initialize?.({ task, taskDir: absoluteDir, files, trace }),
          );
          state = initState ?? undefined;
        }

        session = await trace.step(
          { step_name: "adapter.open-session", input: { adapterName: adapter.name, hasState: state !== undefined }, metadata: { adapterName: adapter.name }, summarize: () => ({ sessionOpened: true }) },
          async () => adapter.startSession({ task, taskDir: absoluteDir, files, state, trace }),
        );

        if (!inlineChecks && checksPath) {
          resetTaskTurn();
          resetFlowChecks();
          await loadChecksModule(checksPath);
        }

        const taskTurn = getTaskTurn();
        resetTaskTurn();
        const turnFn = resolveTurn(adapter.turn, taskTurn);

        if (turnFn) {
          const turnTranscript: TurnRecord[] = [];
          const maxTurns = options?.maxTurnsOverride ?? task.maxTurns ?? 10;
          for (let turnNum = 1; turnNum <= maxTurns; turnNum++) {
            const userTurn = await turnFn({ files: taskFiles, transcript: turnTranscript });
            if (userTurn === null || userTurn === undefined) break;
            const result = await trace.step(
              { step_name: "task.turn", metadata: { turnNumber: turnNum } },
              async (spanId) => {
                if (!session) throw new Error("Session not created");
                return session.sendUserTurn(userTurn, { trace, turnNumber: turnNum, parentSpanId: spanId });
              },
            );
            turnTranscript.push({ turnNumber: turnNum, input: userTurn, output: result.response });
            transcriptTurns.push({ turnNumber: turnNum, userAction: userTurn, agentResponse: result.response });
            options?.onTurn?.(turnNum, userTurn, result.response);
          }
        }

        const collected = await trace.step(
          { step_name: "adapter.collect-deliverables", input: { adapterName: adapter.name, expectedDeliverables: task.deliverables }, metadata: { adapterName: adapter.name }, summarize: (result) => { const keys = result && typeof result === "object" ? Object.keys(result as Record<string, unknown>) : []; return { deliverableCount: keys.length, deliverableNames: keys }; } },
          async () => {
            if (!session) throw new Error("Adapter session was not created");
            return adapter.collectDeliverables({ task, taskDir: absoluteDir, files, state, session, trace });
          },
        );

        // Freeze the snapshot from the projection tee. The root span will end
        // and flush after this callback returns — Phase 2 reads this snapshot.
        const snapshot = tee.getSnapshot();

        return {
          traceRunId: rawTrace.runId,
          collected: collected as Record<string, unknown>,
          transcriptTurns,
          snapshot,
        };
      } finally {
        if (adapter.cleanup) {
          try {
            await trace.step(
              { step_name: "adapter.cleanup", input: { adapterName: adapter.name }, metadata: { adapterName: adapter.name }, summarize: () => ({ cleaned: true }) },
              async () => adapter.cleanup?.({ task, taskDir: absoluteDir, files, state, session, trace }),
            );
          } catch (error) {
            console.error("[AgentTask] Cleanup failed:", error instanceof Error ? error.message : String(error));
          }
        }
        if (session?.close) {
          try { await session.close(); } catch { /* ignore */ }
        }
      }
    },
  );
}

/**
 * Phase 2 (SPEC-130 two-phase split): evaluate deliverables and run checks
 * AFTER the trace has closed and flushed. The snapshot is the frozen Phase-1
 * trace — checks cannot contaminate it because they run outside the trace body.
 */
async function evaluate(
  loaded: LoadedTask,
  options: RunTaskOptions | undefined,
  phase1: CapturedExecution,
): Promise<TaskRunResult> {
  const {
    task,
    adapter,
    taskDir: absoluteDir,
    files,
    checksPath,
    inlineChecks,
    moduleUrl,
    evalFileName,
  } = loaded;

  // Validate deliverables (no longer a trace span — runs outside the trace).
  const validationResults = validateDeliverables(task, phase1.collected, adapter.deliverables);

  const deliverables = proxyBrokenDeliverables(
    phase1.collected,
    validationResults.brokenDeliverables,
  );

  const checksResults = await (inlineChecks
    ? runTraceChecks({
        snapshot: phase1.snapshot,
        deliverables,
        files,
        task,
        judgeConfig: options?.judge,
        moduleUrl,
        displayFile: evalFileName,
      })
    : loadAndRunFlowChecks(
        checksPath,
        {
          snapshot: phase1.snapshot,
          deliverables,
          files,
          task,
          judgeConfig: options?.judge,
        },
        validationResults.brokenDeliverables,
      ));

  const result = aggregateResult(checksResults);

  return {
    task,
    taskDir: absoluteDir,
    files,
    traceRunId: phase1.traceRunId,
    result,
    deliverables: phase1.collected,
    transcript: { turns: phase1.transcriptTurns },
  };
}

/** Compact summary of check evaluation results for span output.
 *
 * Keeps the full reasoning text (not just pass/fail) so the trace view
 * is useful for debugging. Also carries evaluator_type and judge model
 * when available, so the trace shows which checks were LLM-judged.
 */
function summarizeEvaluationResults(results: EvaluationItemResult[]) {
  const passCount = results.filter((r) => r.pass).length;
  return {
    total: results.length,
    passCount,
    failCount: results.length - passCount,
    results: results.map((r) => ({
      id: r.id,
      pass: r.pass,
      reasoning: r.reasoning,
      evaluator_type: r.evaluator_type,
      judge_model: r.judge?.model,
    })),
  };
}

function buildTraceRunOptions(
  loaded: LoadedTask,
  tracing: AgentTaskTraceOptions,
) {  const tags = Array.from(new Set(["agent-task", "e2e", ...(tracing.tags ?? [])]));

  // SPEC-128/129: carry the task-run claim attributes on the root span. The
  // backend projector reads `apo.task.run.id` to atomically link this trace to
  // the task run. These land in rootSpan.metadata today (legacy ingestion);
  // once the runner migrates to OTLP export (Track C) they become real OTel
  // attributes that the projector's claim path reads directly.
  const rootMetadata: Record<string, unknown> = {
    taskId: loaded.task.id,
    taskDir: loaded.taskDir,
    adapterName: loaded.adapter.name,
  };
  if (tracing.taskRunId) {
    rootMetadata[APO_TASK_ID] = loaded.task.id;
    rootMetadata[APO_TASK_RUN_ID] = tracing.taskRunId;
  }

  return {
    project: tracing.project,
    task_id: loaded.task.id,
    flow_name: tracing.flowName ?? `agent-task.${loaded.task.id}`,
    version: tracing.version,
    environment: tracing.environment,
    tags,
    run_metadata: {
      taskDir: loaded.taskDir,
      adapterName: loaded.adapter.name,
      source: "agent-task-e2e",
      ...tracing.runMetadata,
    },
    rootSpan: {
      task_id: loaded.task.id,
      step_name: "agent-task.run",
      observation_type: "CHAIN" as const,
      model: "agent-task",
      metadata: rootMetadata,
    },
  };
}
