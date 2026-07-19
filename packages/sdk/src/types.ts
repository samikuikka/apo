export interface ClientConfig {
  project: string;      // e.g. "plan-china-trips"
  endpoint: string;     // e.g. "http://localhost:8000"
  version?: string;     // e.g. "1.0.0" or Git SHA

  /** Public key (pk-apo-xxx) for two-key auth model */
  publicKey?: string;
  /** Secret key (sk-apo-xxx) for two-key auth model */
  secretKey?: string;

  /** @deprecated Use publicKey + secretKey instead. Legacy single API key (sk-xxx). */
  apiKey?: string;
}

export type ParameterOverrides = Record<string, unknown>;

export interface ClientOptions {
  parameterOverrides?: ParameterOverrides;
  runEvals?: boolean;
}

export interface CallMetadata {
  taskId?: string;      // logical task, e.g. "itinerary_generation"
  userId?: string;
  runId?: string;
  flowName?: string;    // Auto-inferred from registered parameters if not provided
  stepName?: string;    // Auto-inferred from registered parameters if not provided
  stepIndex?: number;
  version?: string;
  isLastCall?: boolean; // Mark this as the last call in a run
  evals?: string[];     // specific metrics to run, e.g. ["faithfulness"]

  // NEW: Session support
  sessionId?: string;

  // NEW: Environment and tags
  environment?: string;
  tags?: string[];

  // NEW: Hierarchy support
  parentCallId?: string;
  callType?: 'generation' | 'span' | 'task';
  level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';

  // NEW: Auto-evaluation
  autoRunEvals?: boolean; // Auto-run all configured evals when isLastCall=true (including LLM-based ones)

  // Parameter metadata used for auto-inferring flowName/stepName
  parameters?: unknown[];

  [key: string]: unknown;
}

// ============================================================================
// Run & Metric Types
// ============================================================================

export interface Run {
  id: string;
  project: string;
  task_id?: string;
  flow_name?: string;
  version?: string;
  user_id?: string;
  created_at: string;
  completed_at?: string;
  duration_ms?: number;
  call_count: number;
}

export interface RunMetric {
  metric_name: string;
  metric_type: "quality" | "aggregate";
  score: number;
  reasoning?: string;
  meta?: Record<string, unknown>;
  created_at: string;
}

export interface RunDetail {
  run: Run;
  metrics: RunMetric[];
  calls: LoggedCall[];
}

export interface RunSummary {
  id: string;
  project: string;
  flow_name?: string;
  task_id?: string;
  version?: string;
  call_count: number;
  duration_ms?: number;
  created_at: string;
  completed_at?: string;
  metrics: RunMetric[];
}

export interface CreateRunRequest {
  project: string;
  task_id?: string;
  flow_name?: string;
  version?: string;
  user_id?: string;
}

export interface UpdateRunRequest {
  completed?: boolean;
  call_count?: number;
  session_id?: string;
  environment?: string;
  external_id?: string;
  tags?: string[];
  run_metadata?: Record<string, unknown>;
}

export interface LoggedCall {
  id: string;
  created_at: string;
  model: string;
  input: Record<string, unknown>;
  messages: Record<string, unknown>[];
  output: Record<string, unknown>;
  latency_ms?: number;
  cost?: number;
  project: string;
  task_id: string;
  run_id?: string;
  flow_name?: string;
  step_name?: string;
  step_index?: number;
  version?: string;
  user_id?: string;
  // Note: eval_results removed - metrics are now at run level

  // NEW: Token usage fields
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;

  // NEW: Model parameters
  model_parameters?: Record<string, unknown>;

  // NEW: Hierarchy support
  parent_call_id?: string;
  call_type?: string;
  level?: string;

  // NEW: Environment and tags
  environment?: string;
  tags?: string[];
}

// ============================================================================
// Langfuse-Style Trace & Span Types (TASK-011, TASK-012, TASK-013)
// ============================================================================

export interface IngestionEvent {
  id: string;
  timestamp: Date;
  type: "run-create" | "call-create" | "call-update" | "score-create";
  body: Record<string, unknown>;
}

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
  input?: Record<string, unknown>;
  messages?: Record<string, unknown>[];
  output?: Record<string, unknown>;
  observation_type?: "GENERATION" | "SPAN" | "TOOL" | "CHAIN" | "RETRIEVER" | "EVALUATOR" | "EMBEDDING" | "GUARDRAIL" | "AGENT";
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

// ============================================================================
// Scoring Types (SPEC-019)
// ============================================================================

export interface CreateScoreParams {
  name: string;
  value: number | string | boolean;
  dataType?: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
  source?: "API" | "EVAL" | "ANNOTATION";
  configId?: number;
  comment?: string;
  observationId?: string;
}

// ============================================================================
// Session Types (TASK-014)
// ============================================================================

export interface Session {
  id: string;
  project: string;
  user_id?: string;
  environment: string;
  created_at: string;
  ended_at?: string;
  run_count: number;
  tags: string[];
}

export interface SessionSummary {
  id: string;
  project: string;
  user_id?: string;
  environment: string;
  created_at: string;
  ended_at?: string;
  run_count: number;
  tags: string[];
}

export interface SessionDetail {
  session: Session;
  runs: Run[];
  total_cost: number;
  total_tokens: number;
}

export interface CreateSessionRequest {
  project: string;
  user_id?: string;
  environment?: string;
  session_metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface UpdateSessionRequest {
  ended?: boolean;
  tags?: string[];
  session_metadata?: Record<string, unknown>;
}

// ============================================================================
// Decorator Types (TASK-015)
// ============================================================================

export interface ObserveOptions {
  /** Unique ID for this observation (trace or span) */
  id?: string;
  /** Project name for grouping traces */
  project?: string;
  /** Flow name (alternative to project) */
  flowName?: string;
  /** Step name for spans */
  stepName?: string;
  /** Observation name (defaults to method name if not provided) */
  name?: string;
  /** User ID for tracking */
  userId?: string;
  /** Session ID for session tracking */
  sessionId?: string;
  /** Environment (e.g., "production", "development") */
  environment?: string;
  /** External ID for linking to external systems */
  externalId?: string;
  /** Tags for filtering and grouping */
  tags?: string[];
  /** Metadata for additional context */
  metadata?: Record<string, unknown>;
  /** Model name (for spans) */
  model?: string;
  /** Explicit input data (overrides automatic extraction) */
  input?: Record<string, unknown>;
  /** Messages array (for chat completions) */
  messages?: Record<string, unknown>[];
  /** Observation type (Langfuse-style) */
  observationType?: "GENERATION" | "SPAN" | "TOOL" | "CHAIN" | "RETRIEVER" | "EVALUATOR" | "EMBEDDING" | "GUARDRAIL" | "AGENT";
  /** Shorthand for observation type */
  as?: "tool" | "retriever" | "chain" | "agent" | "guardrail" | "embedding";
  /** Observation level */
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  /** Whether to capture output (default: true) */
  captureOutput?: boolean;
}

export interface ObservationContext {
  /** Trace ID (run ID) */
  traceId: string;
  /** Current span ID */
  spanId: string;
  /** Flow name */
  flowName: string;
  /** Project name */
  projectName: string;
}

// ============================================================================
// Custom Metrics Types (TASK-001)
// ============================================================================

/**
 * A custom metric for evaluating prompt outputs.
 */
export interface Metric {
  name: string;
  evaluate(params: {
    input: string;
    output: string;
    expected: string;
    metadata?: unknown;
  }): number | Promise<number>;
}
