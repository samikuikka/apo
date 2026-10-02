import type {
  TraceRunContext,
  TraceRunOptions,
  CreateScoreParams,
  CreateSpanParams,
  EndSpanParams,
} from "../types.ts";
import type { TraceEventOptions, TraceStepOptions } from "../types.ts";

export type AgentTaskTraceContext = TraceRunContext & {
  createSpan: (
    options: Omit<CreateSpanParams, "project" | "run_id">,
  ) => string;
  endSpan: (spanId: string, params?: Omit<EndSpanParams, "id">) => void;
};

export type AgentTaskTraceOptions = {
  client: {
    traceRun<T>(
      params: TraceRunOptions,
      fn: (trace: AgentTaskTraceContext) => Promise<T>,
    ): Promise<T>;
    /** End the active run's root span as cancelled and flush it (see
     * createOtelAgentTaskTraceClient). */
    cancelActiveRun(reason?: string): Promise<void>;
  };
  project?: string;
  flowName?: string;
  version?: string;
  environment?: string;
  tags?: string[];
  runMetadata?: Record<string, unknown>;
  /**
   * The Task Run ID this trace should claim. Emitted as the
   * `apo.task.run.id` root-span attribute so the backend projector can
   * atomically link this trace to the task run. Omit for local/programmatic
   * runs that don't have a backend task run.
   */
  taskRunId?: string;
};

export function createNoopAgentTaskTraceContext(): AgentTaskTraceContext {
  const noopFn = async <T>(fn: () => Promise<T>) => fn();
  return {
    runId: "agent-task-untraced",
    rootSpanId: "agent-task-untraced-root",
    async step<T>(options: TraceStepOptions, fn: (spanId: string) => Promise<T>) {
      return fn(options.id ?? "agent-task-untraced-step");
    },
    recordEvent(options: TraceEventOptions) {
      return options.id ?? "agent-task-untraced-event";
    },
    endRoot() {},
    traceTool<T>(_name: string, _params: Record<string, unknown>, fn: () => Promise<T>) {
      return noopFn(fn);
    },
    traceRetriever<T>(_query: string, fn: () => Promise<T>) {
      return noopFn(fn);
    },
    traceChain<T>(_name: string, fn: () => Promise<T>) {
      return noopFn(fn);
    },
    traceAgent<T>(_name: string, fn: () => Promise<T>) {
      return noopFn(fn);
    },
    traceGuardrail<T>(_name: string, fn: () => Promise<T>) {
      return noopFn(fn);
    },
    traceEmbedding<T>(_model: string, _input: unknown, fn: () => Promise<T>) {
      return noopFn(fn);
    },
    async score(_params: CreateScoreParams): Promise<void> {},
    createSpan(_options) {
      return "agent-task-untraced-span";
    },
    endSpan(_spanId, _params) {},
  };
}

/**
 * The slice of the trace context judges use (issue #288): every t.judge call
 * and t.agent session becomes a step span under checks.run, with the verdict
 * summarized post-hoc — the judge's work shows up in the trace view, not
 * only in the check report.
 */
export type JudgeTracer = Pick<AgentTaskTraceContext, "step" | "traceTool">;

/**
 * Whether a step-returned span id identifies a real, linkable span. The noop
 * trace context hands out sentinel ids ("agent-task-untraced-*") so callers
 * need no null-checks — but judge metadata must not record a sentinel as a
 * deep-linkable `span_id` (no trace backs it; the link would 404).
 */
export function isTraceableSpanId(spanId: string | undefined): boolean {
  return spanId !== undefined && !spanId.startsWith("agent-task-untraced");
}
