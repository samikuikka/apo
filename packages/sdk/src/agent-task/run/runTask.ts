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
import { getTaskSteers, resetTaskSteers } from "../steer.ts";
import { createSteerScheduler } from "./steer-scheduler.ts";
import type { SteerRecord } from "./types.ts";
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
import {
  resolveJudgeTools,
  resolveMcpServerPaths,
  type JudgeToolsConfig,
} from "../checks/mcp-tools.ts";
import { freezeHistoryPlaneFromEnv } from "../checks/agent-history.ts";
import type { JudgeTracer } from "../tracing.ts";
import { APO_TASK_ID, APO_TASK_RUN_ID } from "../../semconv.ts";
import { aggregateResult } from "./aggregate.ts";
import type { AgentTaskTraceContext, AgentTaskTraceOptions } from "../tracing.ts";
import { createNoopAgentTaskTraceContext, isTraceableSpanId } from "../tracing.ts";
import {
  replayAdapterTranscript,
  type TranscriptCaptureResult,
} from "../transcript-replay/capture.ts";
import type { LoadedTask } from "../task/loadTask.ts";
import { getActiveApoRun, withApoRun } from "../integrations/run-context.ts";

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
  /**
   * Judge tool config for `t.agent(...)` sessions (MCP evidence servers).
   * Layered under `TaskDefinition.judgeTools` and per-call `tools.mcp`.
   */
  judgeTools?: JudgeToolsConfig;
  onTurn?: (
    turnNumber: number,
    userAction: TaskTranscriptTurn["userAction"],
    agentResponse: unknown,
  ) => void;
  /** Called for every steer outcome (delivered / undelivered / error). */
  onSteer?: (record: SteerRecord) => void;
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

/**
 * Layered judgeTools with path-like stdio entries resolved against the task
 * dir — one contract with TaskDefinition.mcpServers on the adapter plane.
 * Per-call `t.agent(..., { tools: { mcp } })` configs are used verbatim;
 * eval authors writing per-call servers should use absolute paths.
 */
function resolveJudgeToolsForTask(
  runLevel: JudgeToolsConfig | undefined,
  taskLevel: JudgeToolsConfig | undefined,
  taskDir: string,
): JudgeToolsConfig | undefined {
  const layered = resolveJudgeTools(runLevel, taskLevel);
  if (!layered?.mcp) return layered;
  return { mcp: resolveMcpServerPaths(layered.mcp, taskDir) };
}

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
      const canonical = await readCanonicalSnapshot(
        trace,
        phase1.replayObservationFloor,
      );
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
 *
 * When the run replayed a transcript capture, `minObservations` is the local
 * observation count the canonical projection should eventually reach. The
 * replay batch was exported moments before this read, so a snapshot that
 * exists but is still missing those observations gets the same bounded
 * backoff as a not-yet-projected trace — otherwise tool-based checks would
 * evaluate against a projection silently missing the agent's activity.
 */
async function readCanonicalSnapshot(
  trace: AgentTaskTraceOptions,
  minObservations?: number,
): Promise<CapturedExecution["snapshot"] | null> {
  if (!trace.taskRunId) return null; // offline/local run — no backend read
  // NOTE: deliberately still the trace endpoint, not APO_BACKEND_URL. In
  // the caller path the root span (whose ingest-side claim this read waits
  // for) only ends AFTER this read runs, so a reachable backend turns the
  // instant 404 into a guaranteed 30s "not ready" wait — the local tee
  // fallback is the effective design here either way.
  const endpoint = process.env.AGENT_TASK_TRACE_ENDPOINT;
  const authToken = process.env.APO_AUTH_TOKEN;
  if (!endpoint || !authToken) return null;
  const deadlineMs = 30_000;
  const start = Date.now();
  try {
    let snapshot = await readTaskRunProjection({
      endpoint,
      authToken,
      taskRunId: trace.taskRunId,
      deadlineMs,
      // Fresh-run readback: the run row was pre-created by the caller/executor
      // flow, and the subprocess-exported trace may still be in flight when
      // the checks phase starts — a 409 "no trace yet" must wait for the
      // claim, not fall back to a local snapshot that cannot see the
      // subprocess's spans.
      // Fresh-run readback: the run row was pre-created by the caller/executor
      // flow, and the subprocess-exported trace may still be in flight when
      // the checks phase starts — a 409 "no trace yet" must wait for the
      // claim, not fall back to a local snapshot that cannot see the
      // subprocess's spans.
      retryNoTrace: true,
    });
    while (
      minObservations !== undefined &&
      snapshot.observations.length < minObservations
    ) {
      const remaining = deadlineMs - (Date.now() - start);
      if (remaining <= 0) {
        console.error(
          `[AgentTask] Projection still missing replayed observations after ${deadlineMs}ms ` +
            `(${snapshot.observations.length}/${minObservations}); continuing with the current snapshot`,
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      snapshot = await readTaskRunProjection({
        endpoint,
        authToken,
        taskRunId: trace.taskRunId,
        deadlineMs: remaining,
      });
    }
    return snapshot;
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
  /**
   * When a transcript capture was replayed: the observation count the
   * canonical read-back should reach before Phase 2 uses it (see
   * {@link readCanonicalSnapshot}).
   */
  replayObservationFloor?: number;
}

/** What the shared adapter lifecycle hands to the caller's continuation. */
interface AdapterRunOutcome {
  /** Deliverables exactly as the adapter collected them (unvalidated). */
  collected: CollectedDeliverables;
  transcriptTurns: TaskTranscriptTurn[];
  /** The adapter-reported run configuration, captured right after session open. */
  runConfiguration: AgentTaskRunConfiguration | undefined;
  /** The transcript-replay result, when the adapter declared a capture. */
  replay: TranscriptCaptureResult | undefined;
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

          // Transcript-replay capture: the adapter ran a harness that writes a
          // session transcript but emits no OTel. One replay does both halves —
          // spans join the live trace (when the run has one) and observations
          // join the local snapshot — so OTel-less harnesses are first-class.
          // Strict failure semantics: the adapter declared the transcript, so
          // a missing file or failed export (recorded runs) fails the run
          // loudly instead of leaving checks a silently starved projection.
          const transcriptCapture = session?.transcript;
          let replay: TranscriptCaptureResult | undefined;
          if (transcriptCapture) {
            replay = await trace.step(
              {
                step_name: "adapter.replay-transcript",
                input: { source: transcriptCapture.source, path: transcriptCapture.path },
                metadata: { source: transcriptCapture.source },
                summarize: (r) => {
                  const result = r as TranscriptCaptureResult;
                  return {
                    turns: result.turns,
                    spans: result.spanCount,
                    exported: result.exported,
                    warnings: result.warnings.length,
                  };
                },
              },
              async () =>
                replayAdapterTranscript(transcriptCapture, {
                  rootSpanId: rawTrace.rootSpanId,
                  liveTraceId: isTraceableSpanId(rawTrace.runId)
                    ? rawTrace.runId
                    : undefined,
                  endpoint: process.env.AGENT_TASK_TRACE_ENDPOINT,
                }),
            );
            tee.injectObservations(replay.observations);
          }

          return await continueWith({
            collected,
            transcriptTurns,
            runConfiguration,
            replay,
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
        // overrides are applied later, inside t.judge. Layered judgeTools
        // get their path-like stdio entries resolved against the task dir —
        // the SAME contract TaskDefinition.mcpServers follows on the adapter
        // plane, so "./mcp/server.mjs" works regardless of the runner's cwd.
        const judgeConfig = resolveJudgeConfig(options?.judge, task.judge);
        const judgeTools = resolveJudgeToolsForTask(options?.judgeTools, task.judgeTools, absoluteDir);
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
              ...(judgeTools ? { judgeTools } : {}),
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
          ...(judgeTools ? { judgeTools } : {}),
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
    // The floor for the canonical read-back: everything the local snapshot
    // holds (runner spans + replayed observations) should project remotely.
    ...(outcome.replay
      ? { replayObservationFloor: outcome.getSnapshot().observations.length }
      : {}),
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
  // overrides are applied later, inside t.judge. Same path-resolution
  // contract as the merge above.
  const judgeConfig = resolveJudgeConfig(options?.judge, task.judge);
  const judgeTools = resolveJudgeToolsForTask(options?.judgeTools, task.judgeTools, absoluteDir);
  const historyPlane = await freezeHistoryPlaneFromEnv(task.id);

  const runChecks = async (): Promise<EvaluationItemResult[]> =>
    inlineChecks
      ? runTraceChecks({

        ...(judgeTools ? { judgeTools } : {}),
          snapshot: phase1.snapshot,
          deliverables,
          files,
          task,
          ...(judgeConfig ? { judgeConfig } : {}),
          ...(judgeTools ? { judgeTools } : {}),
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
            ...(judgeTools ? { judgeTools } : {}),
            ...(judgeTracer ? { judgeTracer } : {}),
            ...(historyPlane ? { historyPlane } : {}),
          },
          validationResults.brokenDeliverables,
        );

  // The evaluation phase is one CHAIN span every judge span nests under
  // (issue #302): the trace view collapses it into a single muted
  // "Evaluation" row, so judgment work never reads as agent activity. The
  // step's span context stays active for everything the checks execute,
  // which is what parents t.judge/t.agent spans to it.
  // A task with no checks module at all emits nothing — a vacuous
  // "0/0 checks passed" phase on a run that fails NO_CHECKS_REGISTERED would
  // read as noise, not signal.
  const hasChecksModule = inlineChecks || checksPath !== null;
  const checksResults = await (judgeTracer && hasChecksModule
    ? judgeTracer.step(
        {
          step_name: "checks.run",
          observation_type: "CHAIN",
          input: { sourceFile: inlineChecks ? evalFileName : checksPath },
          metadata: { sourceFile: inlineChecks ? evalFileName : checksPath },
          summarize: (result) =>
            summarizeEvaluationResults(result as EvaluationItemResult[]),
        },
        runChecks,
      )
    : runChecks());

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
    resetTaskSteers();
    resetFlowChecks();
    await loadChecksModule(checksPath);
  }

  const taskTurn = getTaskTurn();
  resetTaskTurn();
  const turnFn = resolveTurn(adapter.turn, taskTurn);
  if (!turnFn) return [];

  // Steers register from the eval file (inline) or checks.ts (legacy), the
  // same registry lifecycle as turn(). A task with steers against a harness
  // that cannot inject fails closed before turn 1 — unrunnable, not silently
  // steer-less.
  const steerSpecs = getTaskSteers();
  resetTaskSteers();
  if (steerSpecs.length > 0 && typeof session.steer !== "function") {
    // Thrown directly as AgentTaskRunError: withRunConfiguration only wraps
    // plain errors when a run configuration exists, and steer-less adapters
    // often report none — the CLI must still see the typed error.
    throw new AgentTaskRunError(
      `Task "${task.id}" registers ${steerSpecs.length} steer(s) but adapter "${adapter.name}" does not implement session.steer(). ` +
        `Implement steer() on the adapter session, or remove the steer() registrations.`,
      {},
    );
  }
  // Steer events nest under their turn's span; the id lands in this map the
  // moment the turn's step opens, before any progress event can fire.
  const turnSpanIds = new Map<number, string>();
  const scheduler = createSteerScheduler({
    specs: steerSpecs,
    session,
    trace,
    turnSpanId: (turnNumber) => turnSpanIds.get(turnNumber),
    onSteer: options?.onSteer,
  });

  const taskFiles = new TaskFiles(files);
  const turnTranscript: TurnRecord[] = [];
  const transcriptTurns: TaskTranscriptTurn[] = [];
  let lastTurnResponse: unknown;
  let lastTurnNumber = 0;
  // Precedence: explicit run override → task config → default 10.
  const maxTurns = options?.maxTurnsOverride ?? task.maxTurns ?? 10;

  for (let turnNum = 1; turnNum <= maxTurns; turnNum++) {
    const userTurn = await turnFn({ files: taskFiles, transcript: turnTranscript });
    if (userTurn === null || userTurn === undefined) break;

    await scheduler.onTurnStart(turnNum);
    const result = await trace.step(
      {
        step_name: "task.turn",
        metadata: { turnNumber: turnNum },
        summarize: (r) => ({ response: (r as { response: unknown }).response }),
      },
      // Re-scope the run context to this turn so GenAI spans the OTel
      // processor captures parent under the turn span, not the run root —
      // turn-scoped assertions (t.maxTokens({ turn })) walk that chain.
      async (spanId) => {
        turnSpanIds.set(turnNum, spanId);
        const run = getActiveApoRun();
        const send = () =>
          session.sendUserTurn(userTurn, {
            trace,
            turnNumber: turnNum,
            parentSpanId: spanId,
            // Progress events drive the steer scheduler. Fire-and-forget:
            // the adapter never waits on steering, and scheduler errors are
            // contained (they must not break the agent's turn).
            notifyAgentEvent: (event) => {
              void scheduler.onProgressEvent(turnNum, event).catch((error) => {
                console.error(
                  "[AgentTask] Steer scheduler error:",
                  error instanceof Error ? error.message : String(error),
                );
              });
            },
          });
        return run ? withApoRun({ ...run, parentSpanId: spanId, turnNumber: turnNum }, send) : send();
      },
    );
    // Awaits any in-flight delivery before the turn's steers are finalized —
    // a boundary-race steer the harness accepted still lands.
    await scheduler.onTurnEnd(turnNum);

    const turnSteers = scheduler.recordsByTurn().get(turnNum);
    turnTranscript.push({
      turnNumber: turnNum,
      input: userTurn,
      output: result.response,
    });
    transcriptTurns.push({
      turnNumber: turnNum,
      userAction: userTurn,
      agentResponse: result.response,
      ...(turnSteers !== undefined && turnSteers.length > 0 ? { steers: turnSteers } : {}),
    });
    options?.onTurn?.(turnNum, userTurn, result.response);
    lastTurnResponse = result.response;
    lastTurnNumber = turnNum;
  }

  // Steers whose target turn never ran (maxTurns cut the loop short).
  await scheduler.onRunEnd(lastTurnNumber);

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

/** Compact summary of check evaluation results for the checks.run span output.
 *
 * The verdict (structured counts, one line per check) rides the tool_result
 * channel — the one channel the trace view renders as a JSON tree, same as
 * judge verdicts — while `text` is the human-readable roll-up the collapsed
 * Evaluation row shows. Reasoning is capped per check so a suite of hundreds
 * of judged checks cannot bloat the span into an oversized OTLP export.
 */
function summarizeEvaluationResults(results: EvaluationItemResult[]) {
  const passCount = results.filter((r) => r.pass).length;
  // A check whose only failures are verdict-less (judge errored / evidence
  // unsupported) is "quality unknown", not failed (issue #323) — count it
  // separately so the collapsed Evaluation row never misreports it.
  const noVerdictCount = results.filter(
    (r) => !r.pass && (r.outcome === "error" || r.outcome === "unsupported"),
  ).length;
  const failCount = results.length - passCount - noVerdictCount;
  const suffix = noVerdictCount > 0 ? ` (${noVerdictCount} no-verdict)` : "";
  return {
    text: `${passCount}/${results.length} checks passed${suffix}`,
    verdict: {
      total: results.length,
      passCount,
      failCount,
      noVerdictCount,
      results: results.map((r) => ({
        id: r.id,
        pass: r.pass,
        reasoning: r.reasoning?.slice(0, 2000),
        evaluator_type: r.evaluator_type,
        judge_model: r.judge?.model,
        ...(r.outcome ? { outcome: r.outcome } : {}),
        ...(r.group_id ? { group_id: r.group_id } : {}),
        ...(r.group_name ? { group_name: r.group_name } : {}),
      })),
    },
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
