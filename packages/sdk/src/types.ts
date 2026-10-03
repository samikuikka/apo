// Trace & Span parameter types shared by the tracing surface
// (`tracing.ts`, `otel-trace-client.ts`, `projection-tee.ts`).

export interface CreateTraceParams {
  id?: string;
  project: string;
  task_id?: string;
  flow_name?: string;
  version?: string;
  user_id?: string;
  session_id?: string;
  environment?: string;
  external_id?: string;
  tags?: string[];
  run_metadata?: Record<string, unknown>;
}

export interface CreateSpanParams {
  id?: string;
  project: string;
  task_id: string;
  run_id?: string;
  parent_call_id?: string;
  flow_name?: string;
  step_name?: string;
  step_index?: number;
  version?: string;
  model?: string;
  /** Serving provider of the model, emitted as `gen_ai.provider.name` so
   * runs can be labeled and compared by host (issue #307). Only set when
   * actually known (vendor SDK or baseURL) — never guessed from the model
   * id; the backend renders absent as unknown. */
  provider?: string;
  /** Finer-grained serving route (e.g. a custom gateway host), emitted as
   * `apo.llm.route`. */
  route?: string;
  /** Tool name for TOOL observations; emitted as `gen_ai.tool.name`. */
  tool_name?: string;
  input?: Record<string, unknown>;
  messages?: Record<string, unknown>[];
  output?: Record<string, unknown>;
  observation_type?: "GENERATION" | "SPAN" | "TOOL" | "CHAIN" | "RETRIEVER" | "EVALUATOR" | "EMBEDDING" | "GUARDRAIL" | "AGENT" | "SKILL";
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  user_id?: string;
  metadata?: Record<string, unknown>;
}

export interface EndSpanParams {
  id: string;
  output?: Record<string, unknown>;
  latency_ms?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  /** Reasoning/thinking tokens, when the provider reports them as a distinct
   * dimension. Omit when unreported — unknown must stay unknown, not zero. */
  reasoning_tokens?: number;
  status_message?: string;
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  metadata?: Record<string, unknown>;
}

export interface TraceRunRootSpanOptions
  extends Omit<CreateSpanParams, "project" | "run_id" | "parent_call_id"> {}

export interface TraceRunOptions extends Omit<CreateTraceParams, "project"> {
  project?: string;
  rootSpan?: TraceRunRootSpanOptions;
}

export interface TraceStepOptions
  extends Omit<CreateSpanParams, "project" | "task_id" | "run_id" | "output"> {
  task_id?: string;
  summarize?: (result: unknown) => Record<string, unknown> | undefined;
  /**
   * Post-hoc token-usage extractor — the usage sibling of `summarize`, for
   * spans whose token counts are only known after the work (e.g. judge
   * spans, whose usage rides the judged result). Applied when the span ends;
   * the extracted counts become `gen_ai.usage.*` span attributes.
   */
  usage?: (
    result: unknown,
  ) => { prompt_tokens?: number; completion_tokens?: number } | undefined;
}

export interface TraceEventOptions
  extends Omit<CreateSpanParams, "project" | "task_id" | "run_id"> {
  task_id?: string;
  latency_ms?: number;
}

export interface TraceRunContext {
  runId: string;
  rootSpanId: string;
  step<T>(options: TraceStepOptions, fn: (spanId: string) => Promise<T>): Promise<T>;
  recordEvent(options: TraceEventOptions): string;
  endRoot(params?: Omit<EndSpanParams, "id">): void;
  traceTool<T>(name: string, params: Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
  traceRetriever<T>(query: string, fn: () => Promise<T>): Promise<T>;
  traceChain<T>(name: string, fn: () => Promise<T>): Promise<T>;
  traceAgent<T>(name: string, fn: () => Promise<T>): Promise<T>;
  traceGuardrail<T>(name: string, fn: () => Promise<T>): Promise<T>;
  traceEmbedding<T>(model: string, input: unknown, fn: () => Promise<T>): Promise<T>;
  score(params: CreateScoreParams): Promise<void>;
}

export interface CreateScoreParams {
  name: string;
  value: number | string | boolean;
  dataType?: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
  source?: "API" | "EVAL";
  configId?: number;
  comment?: string;
  observationId?: string;
}
