import type { FileEntry, TaskDefinition } from "../task/types.ts";
import type { AgentTaskTraceContext } from "../tracing.ts";
import type { TurnFn } from "../turn.ts";
import type { TranscriptSource } from "../transcript-replay/types.ts";

export type ValidatableSchemaLike = {
  safeParse: (data: unknown) => {
    success: boolean;
    error?: { message: string };
  };
};

export type DeliverableDefinition =
  | ValidatableSchemaLike
  | {
      schema?: ValidatableSchemaLike;
    }
  | null;

export type CollectedDeliverables = Record<string, unknown>;

export type AgentTurnResult = {
  response: unknown;
};

/**
 * Live progress signal from the agent under test, fired while a turn runs.
 * The adapter forwards these from its harness's event stream via the
 * `notifyAgentEvent` callback on `sendUserTurn`'s context — the runner cannot
 * observe subprocess spans live (the projection tee only sees spans created
 * through the runner's trace context), so the adapter is the source of
 * progress. `run_start` MUST be the first event a turn emits.
 */
export type AgentProgressEvent =
  | { kind: "run_start" }
  | { kind: "tool_result"; toolName?: string }
  | { kind: "assistant_reply" };

/** Where the harness actually queued/landed an injected message. */
export type SteerDeliveryBoundary =
  | "run_start"
  | "tool_results"
  | "assistant_reply";

export type SteerResult = {
  /**
   * The boundary the harness reports for the injection. Harness truth wins
   * over the scheduler's trigger intent — a `{ toolResults: 2 }` steer may
   * land at `assistant_reply` on a harness that drains its queue there.
   */
  boundary: SteerDeliveryBoundary;
};

/** Context handed to `session.steer()`. */
export type SteerContext = {
  trace: AgentTaskTraceContext;
  turnNumber: number;
  steerNumber: number;
};

/**
 * The adapter-reported identity of the agent under test for one Task Run
 * The adapter resolves its configuration (env vars, aliases,
 * defaults), constructs the agent from that same resolved object, and reports
 * the resolved values here.
 *
 * - `model` is the exact identifier the adapter passed to its runtime.
 * - `effort` is the exact short value that the selected model/provider applied
 *   (`low`/`medium`/... or `"default"`). Omit it when effort is unsupported,
 *   ignored, or cannot be verified. A configured default or accepted request
 *   parameter is not an applied effort by itself.
 *
 * The whole configuration is absent (`undefined`) when the adapter does not
 * support reporting it. Values are descriptive — they never affect task
 * selection, execution, scoring, retry, or deduplication.
 */
export interface AgentTaskRunConfiguration {
  model: string;
  effort?: string;
}

export type AdapterRuntimeState = Record<string, unknown>;

export type InitializeContext = {
  task: TaskDefinition;
  taskDir: string;
  files: FileEntry[];
  trace: AgentTaskTraceContext;
};

export type StartSessionContext = {
  task: TaskDefinition;
  taskDir: string;
  files: FileEntry[];
  state?: AdapterRuntimeState;
  trace: AgentTaskTraceContext;
};

export type CollectDeliverablesContext = {
  task: TaskDefinition;
  taskDir: string;
  files: FileEntry[];
  state?: AdapterRuntimeState;
  session: AdapterSession;
  trace: AgentTaskTraceContext;
};

export type CleanupContext = {
  task: TaskDefinition;
  taskDir: string;
  files: FileEntry[];
  state?: AdapterRuntimeState;
  session?: AdapterSession;
  trace: AgentTaskTraceContext;
};

/**
 * A harness session transcript the adapter captured on disk.
 *
 * Declaring one opts the run into transcript-replay capture: after the turn
 * loop, the runner parses the session file and replays it into the run —
 * exported spans join the live trace and projection observations join the
 * snapshot — so a harness that cannot emit OTel (Codex CLI, plain Claude
 * Code, anything that only writes session JSONL) still produces a fully
 * assertable trace. The file must exist and be complete when the turn loop
 * ends; a missing file fails the run.
 */
export type AdapterTranscriptCapture = {
  source: TranscriptSource;
  path: string;
};

export type AdapterSession = {
  /**
   * The adapter's resolved model/effort for this run. Read by
   * `runTask()` immediately after `startSession()` returns, validated, and
   * copied into {@link TaskRunResult.runConfiguration}. Absent for adapters
   * that do not report configuration.
   */
  runConfiguration?: AgentTaskRunConfiguration;
  /**
   * The harness session transcript this run captured. Set as soon as the
   * path is known (typically after the first `sendUserTurn`); the runner
   * reads it once, after the turn loop. See {@link AdapterTranscriptCapture}.
   */
  transcript?: AdapterTranscriptCapture;
  sendUserTurn: (
    turn: unknown,
    context: {
      trace: AgentTaskTraceContext;
      turnNumber: number;
      parentSpanId?: string;
      /**
       * The adapter calls this for every agent progress event while the turn
       * runs. Fire-and-forget (sync void); the runner serializes internally
       * and never lets scheduler errors break the turn. MUST be called with
       * `{ kind: "run_start" }` before the first model call.
       */
      notifyAgentEvent: (event: AgentProgressEvent) => void;
    },
  ) => Promise<AgentTurnResult>;
  /**
   * Mid-run injection primitive. Optional = negotiated capability: a task
   * with registered steers fails closed before turn 1 when this is absent.
   * Resolve when the harness has accepted/queued the message, not when the
   * agent has reacted to it — reaction is asserted afterward by
   * `t.steerDelivered` / `t.afterSteer`.
   */
  steer?: (input: unknown, context: SteerContext) => Promise<SteerResult>;
  close?: () => Promise<void>;
};

export type AdapterDefinition = {
  name: string;
  deliverables: Record<string, DeliverableDefinition>;
  turn?: TurnFn;
  initialize?: (ctx: InitializeContext) => Promise<AdapterRuntimeState | void>;
  startSession: (ctx: StartSessionContext) => Promise<AdapterSession>;
  collectDeliverables: (
    ctx: CollectDeliverablesContext,
  ) => Promise<CollectedDeliverables>;
  cleanup?: (ctx: CleanupContext) => Promise<void>;
};

export type TypedAdapterDefinition<
  TName extends string,
  TDeliverables extends Record<string, DeliverableDefinition>,
  TCollected extends CollectedDeliverables = CollectedDeliverables,
> = Omit<
  AdapterDefinition,
  "name" | "deliverables" | "collectDeliverables"
> & {
  name: TName;
  deliverables: TDeliverables;
  collectDeliverables: (
    ctx: CollectDeliverablesContext,
  ) => Promise<TCollected>;
};
