/**
 * apo semantic conventions — the stable attribute layer on top of OTLP.
 *
 * apo uses standard OpenTelemetry as the transport (OTLP/JSON spans) and
 * standard GenAI semantic conventions (`gen_ai.*`) where they're useful.
 * But `gen_ai.*` is still experimental as of 2026, and some apo concepts
 * (scores, run metadata, observation typing) have no OTel equivalent at all.
 *
 * This module defines the `apo.*` attribute namespace — a stable semantic
 * layer (like Phoenix's OpenInference) that:
 *   1. Encodes apo-specific concepts that OTel doesn't model (scores, runs).
 *   2. Provides a stable contract independent of `gen_ai.*` churn.
 *   3. Is the single source of truth for both the TS SDK and the Python path.
 *
 * The backend's OTLP mapper (`backend/apo/services/otel_mapper.py`) strips the
 * `apo.` prefix and routes these into the internal field names.
 *
 * @module
 */

// ── Observation type ──────────────────────────────────────────────────────
//
// Overrides the mapper's automatic type detection. Set this on any span to
// force its observation_type (GENERATION, TOOL, CHAIN, etc.).

export const APO_OBSERVATION_TYPE = "apo.observation.type" as const;

// ── Run identity ──────────────────────────────────────────────────────────
//
// Carried on the root span of a trace. The backend's OTLP route synthesizes a
// run-create from the first-seen traceId; these attributes populate the run's
// task_id, flow_name, version, and tags.

export const APO_RUN_ID = "apo.run.id" as const;
export const APO_RUN_FLOW_NAME = "apo.run.flow_name" as const;
export const APO_RUN_TASK_ID = "apo.run.task_id" as const;
export const APO_RUN_VERSION = "apo.run.version" as const;
export const APO_RUN_TAGS = "apo.run.tags" as const; // JSON array string

// ── Task-run ownership (SPEC-129 §5) ──────────────────────────────────────
//
// Carried on the root span of a task-run Trace. The backend projector reads
// `apo.task.run.id` and atomically claims `AgentTaskRunDB.trace_run_id`,
// enforcing the one-trace-per-task-run invariant (SPEC-128). Without these
// attributes the claim path never fires for agent-task runs.

export const APO_TASK_ID = "apo.task.id" as const;
export const APO_TASK_RUN_ID = "apo.task.run.id" as const;

// Scores are domain records via the HTTP score API, not sentinel spans.
// See `score()` in `@apo/sdk/otel` — it calls POST /api/v1/traces/{id}/scores.

// ── Cost ──────────────────────────────────────────────────────────────────
//
// Optional client-computed cost for a GENERATION span. The backend also
// computes `calculated_cost` server-side from token counts + model pricing;
// this attribute carries the client-side estimate if the client has it.

export const APO_COST = "apo.cost" as const;

// ── Enumeration values ────────────────────────────────────────────────────

export const OBSERVATION_TYPES = [
  "GENERATION",
  "SPAN",
  "TOOL",
  "CHAIN",
  "RETRIEVER",
  "EVALUATOR",
  "EMBEDDING",
  "GUARDRAIL",
  "AGENT",
] as const;

export const SCORE_DATA_TYPES = ["NUMERIC", "CATEGORICAL", "BOOLEAN"] as const;

export const SCORE_SOURCES = ["API", "EVAL", "ANNOTATION"] as const;
