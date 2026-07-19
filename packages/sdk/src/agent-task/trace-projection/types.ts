/**
 * Trace Projection snapshot contract (SPEC-130 Track A).
 *
 * This is the immutable transport/read snapshot of a Trace Projection — the
 * query-optimized representation shared by the dashboard and agent-task
 * assertions. It is NOT a new domain entity and never a source of truth; the
 * canonical OpenTelemetry spans remain authoritative.
 *
 * Both the Python backend and the TypeScript SDK MUST serialize to this exact
 * lower-camel-case JSON contract, so assertions read the same shape whether
 * the snapshot came from the canonical repository, a local/offline recorder,
 * or a legacy-Flow compatibility adapter.
 *
 * Rules (SPEC-130 §Interface):
 * - `schemaVersion` versions the JSON contract.
 * - `projectionVersion` identifies the normalizer/projector interpretation.
 * - `source` is diagnostic; only `"canonical"` represents a durably projected
 *   Trace.
 * - `complete` means the task execution root ended and every span in the
 *   acknowledged export was projected. It does not promise no unrelated
 *   service will ever export a late span.
 * - Missing evidence is represented through `capabilities`, never converted to
 *   empty arrays, zero duration, or successful status.
 * - Observations are immutable and sorted deterministically by invocation
 *   time, then span ID. Missing timestamps sort after timestamped ones.
 */

/** Whether a category of evidence is present in the projection. */
export type EvidenceAvailability = "available" | "partial" | "unavailable";

/** Lifecycle status of an observation. `unset` = the source had no status. */
export type ObservationStatus = "unset" | "ok" | "error";

/** What kind of Span an Observation was derived from. */
export type ObservationType =
  | "SPAN"
  | "GENERATION"
  | "TOOL"
  | "AGENT"
  | "SKILL"
  | "CHAIN"
  | "RETRIEVER"
  | "EMBEDDING"
  | "GUARDRAIL";

/**
 * Per-category evidence availability. Every category must declare honestly
 * what it carries so assertions can fail closed when evidence is missing
 * instead of vacuously passing.
 */
export interface TraceProjectionCapabilities {
  messages: EvidenceAvailability;
  tools: EvidenceAvailability;
  errors: EvidenceAvailability;
  timing: EvidenceAvailability;
  skills: EvidenceAvailability;
  subagents: EvidenceAvailability;
}

/** One chat message reconstructed from a generation observation. */
export interface TraceProjectionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/**
 * A derived interpretation of one Span, as shown by the dashboard and read by
 * assertions. Unknown span kinds survive as `SPAN`; hierarchy is preserved via
 * `parentSpanId`.
 */
export interface TraceProjectionObservation {
  spanId: string;
  parentSpanId?: string;
  type: ObservationType;
  name: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  status: ObservationStatus;
  errorMessage?: string;
  input?: unknown;
  output?: unknown;
  model?: string;
  toolName?: string;
  toolParameters?: unknown;
  toolResult?: unknown;
  messages?: readonly TraceProjectionMessage[];
  metadata?: Readonly<Record<string, unknown>>;
}

/** Trace-level facts. All timing is optional; absence is honest. */
export interface TraceProjectionTrace {
  traceId: string;
  taskRunId?: string;
  name?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  complete: boolean;
}

/**
 * The immutable read snapshot. Identical JSON shape across canonical, local,
 * and legacy-flow sources — only `source` and `capabilities` differ.
 */
export interface TraceProjectionSnapshot {
  schemaVersion: 1;
  projectionVersion: number;
  source: "canonical" | "local" | "legacy-flow";
  trace: TraceProjectionTrace;
  capabilities: TraceProjectionCapabilities;
  observations: readonly TraceProjectionObservation[];
}
