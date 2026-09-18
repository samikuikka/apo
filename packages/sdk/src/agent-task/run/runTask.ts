import type {
  TaskRunResult,
  EvaluationItemResult,
  TaskTranscriptTurn,
} from "./types.ts";
import type {
  AgentTaskRunConfiguration,
  AdapterRuntimeState,
  AdapterSession,
  CollectedDeliverables,
} from "../adapter/types.ts";
import { normalizeRunConfiguration } from "./run-configuration.ts";
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
import type { TraceProjectionSnapshot } from "../trace-projection/types.ts";
import { readTaskRunProjection } from "../trace-projection/remote-capture.ts";
import { resolveJudgeConfig, type JudgeConfig } from "../checks/t.ts";
import { freezeHistoryPlaneFromEnv } from "../checks/agent-history.ts";
import type { JudgeTracer } from "../tracing.ts";
import { APO_TASK_ID, APO_TASK_RUN_ID } from "../../semconv.ts";
import { aggregateResult } from "./aggregate.ts";
import type { AgentTaskTraceContext, AgentTaskTraceOptions } from "../tracing.ts";
import { createNoopAgentTaskTraceContext } from "../tracing.ts";
import type { LoadedTask } from "../task/loadTask.ts";
import { withApoRun } from "../integrations/run-context.ts";

/**
 * Error thrown when a Task Run fails after the adapter's Run Configuration
 * has been resolved. Carries the resolved {@link AgentTaskRunConfiguration} so
 * callers (e.g. the CLI error-report path) can forward model/effort to the
 * backend even when the run never produced a summary (issue #40).
 *
 * The original failure is preserved on `cause`. Only errors thrown after
 * `startSession` reported a *valid* configuration are wrapped — a
 * configuration-validation failure propagates unwrapped (there is nothing to
 * attach).
 */
export class AgentTaskRunError extends Error {
  readonly runConfiguration?: AgentTaskRunConfiguration;
  /** The original error that caused the run to fail (preserved for diagnostics). */
  readonly cause?: unknown;
  constructor(
    message: string,
    options: { runConfiguration?: AgentTaskRunConfiguration; cause?: unknown },
  ) {
    super(message);
    this.name = "AgentTaskRunError";
    this.runConfiguration = options.runConfiguration;
    this.cause = options.cause;
  }
}

/**
 * Wrap an error with the resolved Run Configuration so it survives the throw
 * out of the run. Returns the original error unchanged when there is no
 * configuration to attach (old adapter) or when it is already branded.
 */
function withRunConfiguration(
  error: unknown,
  runConfiguration: AgentTaskRunConfiguration | undefined,
): unknown {
  if (!runConfiguration) return error;
  if (error instanceof AgentTaskRunError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AgentTaskRunError(message, { runConfiguration, cause: error });
}

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
  /**
   * Skip the internal `loadTask(taskDir)` call and reuse an already-loaded
   * task definition.
   *
   * The eval module's top level runs once per `loadTask` (it is copied to a
   * temp file and imported with all registries reset), so loading twice per
   * run breaks evals whose load-time behavior is not idempotent across module
   * systems (e.g. a helper that re-exports CJS `require()`-cached registrations
   * — the second import hits the cache and registers zero checks). Callers
   * that already need a `LoadedTask` for their own purposes (`runTaskDir`,
   * `runner-entry.ts`) should always pass it through here to keep the eval
   * import count at exactly one per run.
   *
   * When omitted, `runTask` calls `loadTask(taskDir)` itself. The `taskDir`
   * argument is still required for that fallback and is otherwise unused.
   */
  loaded?: LoadedTask;
};

export async function runTask(
  taskDir: string,
  options?: RunTaskOptions,
): Promise<TaskRunResult> {
  // Reuse an already-loaded task when provided — see `RunTaskOptions.loaded`.
  // Otherwise load it here (the eval module is imported exactly once either way).
  const loaded = options?.loaded ?? (await loadTask(taskDir));
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

  // Both phases run inside the traceRun callback so evaluation-phase spans
  // (checks.run, judge calls, t.agent sessions — issue #288) export before
  // the root ends. Contamination is impossible by construction: the frozen
  // snapshot Phase 2 evaluates against was captured in Phase 1, before any
  // check ran; evaluation spans only enrich the trace view.
  return trace.client.traceRun(
    buildTraceRunOptions(loaded, trace),
    async (traceContext) => {
      const phase1 = await captureExecution(loaded, options, traceContext);

      // when this run is backend-launched (has a taskRunId),
      // read the canonical projection snapshot back from the backend instead of
      // the local tee. The backend's projection is the single source of truth —
      // it includes spans the subprocess exported natively over OTLP (which the
      // in-process tee can never see, since they're created in another process).
      // Falls back to the local snapshot on any failure (offline runs, unreachable
      // backend, projection timeout) so evaluation still runs.
      const canonical = await readCanonicalSnapshot(trace);
      if (canonical) phase1.snapshot = canonical;

      // Phase 2: evaluate against the frozen snapshot, inside the export
      // window, with the live context as the judge tracer.
      return evaluate(loaded, options, phase1, traceContext);
    },
  );
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
  /** The adapter-reported run configuration, captured right after session open. */
  runConfiguration: AgentTaskRunConfiguration | undefined;
  /** The frozen projection snapshot Phase 2 evaluates against. */
  snapshot: TraceProjectionSnapshot;
}

/** What the shared adapter lifecycle hands to the caller's continuation. */
interface AdapterRunOutcome {
  /** Deliverables exactly as the adapter collected them (unvalidated). */
  collected: CollectedDeliverables;
  transcriptTurns: TaskTranscriptTurn[];
  /** The adapter-reported run configuration, captured right after session open. */
  runConfiguration: AgentTaskRunConfiguration | undefined;
  /** The tee-wrapped trace context — continuations must keep using this. */
  trace: AgentTaskTraceContext;
  /** Freeze the projection snapshot. Call before the root span ends. */
  getSnapshot: () => TraceProjectionSnapshot;
}

/**
 * Run the shared adapter lifecycle — initialize → open-session → Task Turns →
 * collect deliverables — then hand the result to `continueWith`.
 *
 * This is the one place the adapter lifecycle exists. The two run paths differ
 * only in what happens after deliverable collection: the untraced one-pass
 * path continues straight into validation + checks inside the trace
 * ({@link executeLoadedTask}), while the two-phase capture path freezes the
 * projection snapshot and returns for later evaluation ({@link captureExecution}).
 *
 * The continuation runs inside the same error boundary: anything that throws
 * after the Run Configuration is resolved is wrapped with it (issue #40), and
 * adapter cleanup + session close always run afterward, success or failure.
 */
async function executeAdapterRun<T>(
  loaded: LoadedTask,
  options: RunTaskOptions | undefined,
  rawTrace: AgentTaskTraceContext,
  continueWith: (outcome: AdapterRunOutcome) => Promise<T>,
): Promise<T> {
  const {
    task,
    adapter,
    taskDir: absoluteDir,
    files,
    checksPath,
    inlineChecks,
  } = loaded;
  // Tee the trace so the run's tool/agent/message spans also build the
  // projection snapshot that checks read. `trace` below is the wrapped context.
  const tee = createProjectionTee(rawTrace);
  const trace = tee.trace;

  // Establish the run on AsyncLocalStorage so the OTel SpanProcessor
  // (if registered) can route GenAI spans to this run's trace context.
  return withApoRun(
    { trace, parentSpanId: rawTrace.rootSpanId, taskId: task.id },
    async () => {
      let state: AdapterRuntimeState | undefined;
      let session: AdapterSession | undefined;

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

        // Capture the adapter's resolved model/effort immediately after
        // the session opens and validate it before the first Task Turn. An
        // invalid reported configuration is an adapter contract error and
        // fails the run.
        const runConfiguration = normalizeRunConfiguration(
          session.runConfiguration,
        );

        // Issue #40: anything that throws past this point (a Task Turn,
        // deliverable collection, checks) must carry the resolved
        // configuration out so callers can still report model/effort on an
        // errored run.
        try {
          const transcriptTurns = await runTurnLoop(
            loaded,
            options,
            session,
            trace,
            rawTrace,
          );

          const collected = await trace.step(
            {
              step_name: "adapter.collect-deliverables",
              input: {
                adapterName: adapter.name,
                expectedDeliverables: task.deliverables,
              },
              metadata: { adapterName: adapter.name },
              summarize: (result) => {
                const keys =
                  result && typeof result === "object"
                    ? Object.keys(result as Record<string, unknown>)
                    : [];
                return {
                  deliverableCount: keys.length,
                  deliverableNames: keys,
                };
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

          return await continueWith({
            collected,
            transcriptTurns,
            runConfiguration,
            trace,
            getSnapshot: () => tee.getSnapshot(),
          });
        } catch (error) {
          throw withRunConfiguration(error, runConfiguration);
        }
      } finally {
        await cleanupAdapter(loaded, trace, state, session);
      }
    },
  );
}

/**
 * One-pass path (no tracing): the adapter lifecycle, deliverable validation,
 * and checks all run in a single pass — there is no trace to contaminate, so
 * the two-phase split is unnecessary.
 */
async function executeLoadedTask(
  loaded: LoadedTask,
  options: RunTaskOptions | undefined,
  rawTrace: AgentTaskTraceContext,
  traceRunId: string | undefined,
): Promise<TaskRunResult> {
  return executeAdapterRun(loaded, options, rawTrace, async (outcome) => {
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
    const { trace, collected, transcriptTurns, runConfiguration } = outcome;

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
        // Task-level judge config beats the run-level one (#161); per-call
        // overrides are applied later, inside t.judge.
        const judgeConfig = resolveJudgeConfig(options?.judge, task.judge);
        const historyPlane = await freezeHistoryPlaneFromEnv(task.id);
        if (!inlineChecks) {
          return loadAndRunFlowChecks(
            checksPath,
            {
              snapshot: outcome.getSnapshot(),
              deliverables: collected,
              files,
              task,
              ...(judgeConfig ? { judgeConfig } : {}),
              judgeTracer: trace,
              ...(historyPlane ? { historyPlane } : {}),
            },
            validationResults.brokenDeliverables,
          );
        }
        return runTraceChecks({
          snapshot: outcome.getSnapshot(),
          deliverables: proxyBrokenDeliverables(
            collected,
            validationResults.brokenDeliverables,
          ),
          files,
          task,
          ...(judgeConfig ? { judgeConfig } : {}),
          judgeTracer: trace,
          ...(historyPlane ? { historyPlane } : {}),
          moduleUrl,
          displayFile: evalFileName,
        });
      },
    );

    return {
      task,
      taskDir: absoluteDir,
      files,
      traceRunId,
      result: aggregateResult(checksResults),
      deliverables: collected,
      transcript: { turns: transcriptTurns },
      runConfiguration,
    };
  });
}

/**
 * Phase 1: capture the execution inside the trace.
 * Runs adapter init → session → turns → deliverable collection → cleanup.
 * Excludes deliverable validation and checks — those run in Phase 2, after the
 * root span ends and the trace flushes, so they cannot contaminate the trace.
 */
async function captureExecution(
  loaded: LoadedTask,
  options: RunTaskOptions | undefined,
  rawTrace: AgentTaskTraceContext,
): Promise<CapturedExecution> {
  return executeAdapterRun(loaded, options, rawTrace, async (outcome) => ({
    traceRunId: rawTrace.runId,
    collected: outcome.collected,
    transcriptTurns: outcome.transcriptTurns,
    runConfiguration: outcome.runConfiguration,
    // Freeze the snapshot before the root span ends — Phase 2 reads it.
    snapshot: outcome.getSnapshot(),
  }));
}

/**
 * Phase 2: evaluate deliverables and run checks
 * AFTER the trace has closed and flushed. The snapshot is the frozen Phase-1
 * trace — checks cannot contaminate it because they run outside the trace body.
 */
async function evaluate(
  loaded: LoadedTask,
  options: RunTaskOptions | undefined,
  phase1: CapturedExecution,
  judgeTracer?: JudgeTracer,
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

  // Task-level judge config beats the run-level one (#161); per-call
  // overrides are applied later, inside t.judge.
  const judgeConfig = resolveJudgeConfig(options?.judge, task.judge);
  const historyPlane = await freezeHistoryPlaneFromEnv(task.id);

  const checksResults = await (inlineChecks
    ? runTraceChecks({
        snapshot: phase1.snapshot,
        deliverables,
        files,
        task,
        ...(judgeConfig ? { judgeConfig } : {}),
        ...(judgeTracer ? { judgeTracer } : {}),
        ...(historyPlane ? { historyPlane } : {}),
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
          ...(judgeConfig ? { judgeConfig } : {}),
          ...(judgeTracer ? { judgeTracer } : {}),
          ...(historyPlane ? { historyPlane } : {}),
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
    runConfiguration: phase1.runConfiguration,
  };
}

/**
 * Drive the Task Turn loop: resolve the turn function (legacy two-file tasks
 * register `turn()` from checks.ts; single-file tasks registered it while
 * loadTask imported the eval file), then exchange user turns with the session
 * until it yields null/undefined or `maxTurns` is reached. The final
 * response is rolled up to the run root so the trace header / run list shows
 * what the agent answered at a glance (issue #45).
 */
async function runTurnLoop(
  loaded: LoadedTask,
  options: RunTaskOptions | undefined,
  session: AdapterSession,
  trace: AgentTaskTraceContext,
  rawTrace: AgentTaskTraceContext,
): Promise<TaskTranscriptTurn[]> {
  const { task, adapter, files, checksPath, inlineChecks } = loaded;

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
  if (!turnFn) return [];

  const taskFiles = new TaskFiles(files);
  const turnTranscript: TurnRecord[] = [];
  const transcriptTurns: TaskTranscriptTurn[] = [];
  let lastTurnResponse: unknown;
  // Precedence: explicit run override → task config → default 10.
  const maxTurns = options?.maxTurnsOverride ?? task.maxTurns ?? 10;

  for (let turnNum = 1; turnNum <= maxTurns; turnNum++) {
    const userTurn = await turnFn({ files: taskFiles, transcript: turnTranscript });
    if (userTurn === null || userTurn === undefined) break;

    const result = await trace.step(
      {
        step_name: "task.turn",
        metadata: { turnNumber: turnNum },
        summarize: (r) => ({ response: (r as { response: unknown }).response }),
      },
      async (spanId) =>
        session.sendUserTurn(userTurn, {
          trace,
          turnNumber: turnNum,
          parentSpanId: spanId,
        }),
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
    lastTurnResponse = result.response;
  }

  if (lastTurnResponse !== undefined) {
    rawTrace.endRoot({ output: { response: lastTurnResponse } });
  }
  return transcriptTurns;
}

/**
 * Adapter teardown: run `adapter.cleanup` as a traced step (cleanup failures
 * are logged, never thrown — they must not mask the run's own outcome), then
 * close the session if it has a close hook.
 */
async function cleanupAdapter(
  loaded: LoadedTask,
  trace: AgentTaskTraceContext,
  state: AdapterRuntimeState | undefined,
  session: AdapterSession | undefined,
): Promise<void> {
  const { task, adapter, taskDir: absoluteDir, files } = loaded;

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

  // Carry the task-run claim attributes on the root span. The
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
