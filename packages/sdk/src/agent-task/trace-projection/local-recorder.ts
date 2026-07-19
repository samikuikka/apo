/**
 * LocalTraceProjectionRecorder (SPEC-130 Track A).
 *
 * An ephemeral, backend-independent recorder: it records the existing
 * {@link AgentTaskTraceContext} span lifecycle into a
 * {@link TraceProjectionSnapshot} without HTTP or durable storage. This keeps
 * local/offline agent-task testing working once the assertion surface consumes
 * projection snapshots instead of an in-memory Flow.
 *
 * It is NOT a second canonical store. It uses the same snapshot schema and
 * capability semantics as the backend reader (Test 8 parity), so assertions
 * cannot tell a local capture apart from a canonical one by the facts they
 * query — only by `source: "local"`.
 */

import type {
  AgentTaskTraceContext,
} from "../tracing.ts";
import type {
  CreateSpanParams,
  EndSpanParams,
  TraceEventOptions,
  TraceRunOptions,
  TraceStepOptions,
} from "../../types.ts";
import type { CreateScoreParams } from "../../types.ts";
import {
  type ObservationStatus,
  type TraceProjectionCapabilities,
  type TraceProjectionObservation,
  type TraceProjectionSnapshot,
} from "./types.ts";

/** The value and its immutable trace snapshot, captured together. */
export interface CapturedTaskExecution<T> {
  value: T;
  traceId: string;
  snapshot: TraceProjectionSnapshot;
}

/**
 * Captures an execution's span lifecycle into a projection snapshot.
 * Track A's local implementation; the canonical remote capture (Track C) will
 * satisfy the same interface.
 */
export interface AgentTaskTraceCapture {
  capture<T>(
    options: TraceRunOptions & { taskRunId?: string },
    execute: (trace: AgentTaskTraceContext) => Promise<T>,
  ): Promise<CapturedTaskExecution<T>>;
  /**
   * Read the current (possibly partial) projection snapshot. After the root
   * span ends this is the frozen Phase-1 snapshot that Phase-2 evaluation
   * should read. Used by the two-phase execution split (SPEC-130 Track C).
   */
  getSnapshot(): TraceProjectionSnapshot;
}

// Sub-millisecond monotonic clock — same rationale as createTraceClient /
// trace.ts: fast spans round to 0ms under Date.now().
function monotonicNowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** One span being recorded — accumulates start params, completed at endSpan. */
interface PendingObservation {
  spanId: string;
  parentSpanId?: string;
  type: TraceProjectionObservation["type"];
  name: string;
  startedAtIso: string;
  startedAtMs: number;
  model?: string;
  input?: unknown;
}

/** Map an SDK observation_type to a projection observation type. Unknown -> SPAN. */
function observationTypeFor(
  t: CreateSpanParams["observation_type"],
): TraceProjectionObservation["type"] {
  switch (t) {
    case "GENERATION": return "GENERATION";
    case "TOOL": return "TOOL";
    case "AGENT": return "AGENT";
    case "CHAIN": return "CHAIN";
    case "RETRIEVER": return "RETRIEVER";
    case "EMBEDDING": return "EMBEDDING";
    case "GUARDRAIL": return "GUARDRAIL";
    default: return "SPAN";
  }
}

/**
 * Create a local, backend-independent recorder. `capture()` runs `execute`
 * against a real {@link AgentTaskTraceContext}, records every span lifecycle
 * event, then freezes the result into an immutable snapshot.
 */
export function createLocalTraceProjectionRecorder(): AgentTaskTraceCapture {
  // Recorder state, lifted to the object scope so getSnapshot() can read it
  // during the two-phase split (Phase 2 reads the frozen snapshot after the
  // root span ends but before capture() returns).
  let currentTraceId: string | null = null;
  let currentFlowName: string | null = null;
  let currentTaskRunId: string | null = null;
  let rootStartIso: string | null = null;
  let rootStartMs = 0;
  // Observations accumulated during the current capture — accessible via
  // getSnapshot() so Phase 2 can read the frozen trace.
  let currentObservations: TraceProjectionObservation[] = [];

  function buildSnapshot(): TraceProjectionSnapshot {
    return {
      schemaVersion: 1,
      projectionVersion: 1,
      source: "local",
      trace: {
        traceId: currentTraceId ?? "unknown",
        startedAt: rootStartIso ?? undefined,
        endedAt: new Date(monotonicNowMs()).toISOString(),
        durationMs: rootStartMs ? round3(monotonicNowMs() - rootStartMs) : undefined,
        complete: true,
        ...(currentTaskRunId ? { taskRunId: currentTaskRunId } : {}),
        ...(currentFlowName ? { name: currentFlowName } : {}),
      },
      capabilities: deriveCapabilities(currentObservations),
      observations: [...currentObservations],
    };
  }

  const recorder: AgentTaskTraceCapture = {
    getSnapshot(): TraceProjectionSnapshot {
      if (!currentTraceId) {
        throw new Error("getSnapshot() called before capture() — no snapshot available");
      }
      return buildSnapshot();
    },

    async capture<T>(
      options: TraceRunOptions & { taskRunId?: string },
      execute: (trace: AgentTaskTraceContext) => Promise<T>,
    ): Promise<CapturedTaskExecution<T>> {
      const traceId = `local-trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const rootSpanId = `local-root-${Math.random().toString(36).slice(2, 8)}`;
      // Set the lifted state so getSnapshot() works during the two-phase split.
      currentTraceId = traceId;
      currentFlowName = options.flow_name ?? null;
      currentTaskRunId = options.taskRunId ?? null;
      rootStartMs = monotonicNowMs();
      rootStartIso = new Date(rootStartMs).toISOString();
      currentObservations = [];

      const pending = new Map<string, PendingObservation>();
      // Monotonic span counter: when sub-millisecond spans share an ISO
      // timestamp, this preserves invocation order so the deterministic
      // span-ID tie-breaker in TraceView sorts them as they happened. The
      // counter is encoded into the span ID as a zero-padded prefix.
      let spanCounter = 0;
      /** Produce a span ID whose lexicographic order matches creation order. */
      const makeSpanId = (prefix: string): string => {
        spanCounter += 1;
        return `local-${prefix}-${String(spanCounter).padStart(6, "0")}-${Math.random().toString(36).slice(2, 6)}`;
      };
      // The root observation is itself part of the projection.
      const rootPending: PendingObservation = {
        spanId: rootSpanId,
        type: "CHAIN",
        name: options.flow_name ? `${options.flow_name}.run` : "trace.run",
        startedAtIso: rootStartIso,
        startedAtMs: rootStartMs,
      };
      pending.set(rootSpanId, rootPending);

      // observations is currentObservations (lifted to object scope for getSnapshot).
      const observations = currentObservations;

      function complete(spanId: string, params: Omit<EndSpanParams, "id"> | undefined): void {
        const p = pending.get(spanId);
        if (!p) return;
        pending.delete(spanId);
        const endedAtMs = monotonicNowMs();
        const endedAtIso = new Date(endedAtMs).toISOString();
        const isError = params?.level === "ERROR";
        const status: ObservationStatus = isError ? "error" : "ok";

        const obs: TraceProjectionObservation = {
          spanId: p.spanId,
          type: p.type,
          name: p.name,
          startedAt: p.startedAtIso,
          endedAt: endedAtIso,
          durationMs: round3(endedAtMs - p.startedAtMs),
          status,
        };
        if (p.parentSpanId) obs.parentSpanId = p.parentSpanId;
        if (p.model) obs.model = p.model;
        if (isError && params?.status_message) obs.errorMessage = params.status_message;

        // Tool-specific fields, sourced from metadata (matches traceTool's shape)
        // or the raw input/output.
        const meta = params?.metadata as Record<string, unknown> | undefined;
        if (p.type === "TOOL") {
          obs.toolName = (meta?.tool_name as string | undefined) ?? p.name;
          if (meta?.tool_parameters !== undefined) obs.toolParameters = meta.tool_parameters;
          else if (p.input !== undefined) obs.toolParameters = p.input;
          if (meta?.tool_result !== undefined) obs.toolResult = meta.tool_result;
          else if (params?.output !== undefined) obs.output = params.output;
        } else if (params?.output !== undefined) {
          obs.output = params.output;
        }

        // Generation messages: if the output carries a text field, surface it.
        if (p.type === "GENERATION" && params?.output != null) {
          const text = extractText(params.output);
          if (text !== "") {
            obs.messages = [{ role: "assistant", content: text }];
          }
        }

        observations.push(obs);
      }

      const trace: AgentTaskTraceContext = {
        runId: traceId,
        rootSpanId,
        async step<TStep>(opts: TraceStepOptions, fn: (spanId: string) => Promise<TStep>): Promise<TStep> {
          const spanId = makeSpanId("step");
          pending.set(spanId, {
            spanId,
            parentSpanId: opts.parent_call_id ?? rootSpanId,
            type: observationTypeFor(opts.observation_type),
            name: opts.step_name ?? "step",
            startedAtIso: new Date(monotonicNowMs()).toISOString(),
            startedAtMs: monotonicNowMs(),
            model: opts.model,
            input: opts.input,
          });
          const start = monotonicNowMs();
          try {
            const result = await fn(spanId);
            complete(spanId, { latency_ms: round3(monotonicNowMs() - start), output: opts.summarize?.(result), metadata: opts.metadata });
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            complete(spanId, { latency_ms: round3(monotonicNowMs() - start), status_message: message, level: "ERROR", metadata: { ...opts.metadata, failed: true } });
            throw error;
          }
        },
        recordEvent(evOptions: TraceEventOptions): string {
          const spanId = makeSpanId("event");
          pending.set(spanId, {
            spanId,
            parentSpanId: evOptions.parent_call_id ?? rootSpanId,
            type: observationTypeFor(evOptions.observation_type),
            name: evOptions.step_name ?? "event",
            startedAtIso: new Date(monotonicNowMs()).toISOString(),
            startedAtMs: monotonicNowMs(),
            model: evOptions.model,
            input: evOptions.input,
          });
          complete(spanId, { latency_ms: evOptions.latency_ms, output: evOptions.output, metadata: evOptions.metadata });
          return spanId;
        },
        endRoot(endParams?: Omit<EndSpanParams, "id">): void {
          complete(rootSpanId, endParams);
        },
        async traceTool<TT>(name: string, params: Record<string, unknown>, fn: () => Promise<TT>): Promise<TT> {
          const spanId = trace.createSpan({
            task_id: `tool.${name}`,
            step_name: name,
            model: name,
            observation_type: "TOOL",
            input: params,
            metadata: { tool_name: name, tool_parameters: params },
            parent_call_id: rootSpanId,
          });
          const start = monotonicNowMs();
          try {
            const result = await fn();
            trace.endSpan(spanId, {
              latency_ms: round3(monotonicNowMs() - start),
              output: toOutput(result),
              metadata: { tool_name: name, tool_parameters: params, tool_result: result },
            });
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            trace.endSpan(spanId, { latency_ms: round3(monotonicNowMs() - start), status_message: message, level: "ERROR" });
            throw error;
          }
        },
        async traceRetriever<TT>(query: string, fn: () => Promise<TT>): Promise<TT> {
          return runNonLlm(trace, "RETRIEVER", "retriever", query, fn);
        },
        async traceChain<TT>(name: string, fn: () => Promise<TT>): Promise<TT> {
          return runNonLlm(trace, "CHAIN", name, name, fn);
        },
        async traceAgent<TT>(name: string, fn: () => Promise<TT>): Promise<TT> {
          return runNonLlm(trace, "AGENT", name, name, fn);
        },
        async traceGuardrail<TT>(name: string, fn: () => Promise<TT>): Promise<TT> {
          return runNonLlm(trace, "GUARDRAIL", name, name, fn);
        },
        async traceEmbedding<TT>(model: string, _input: unknown, fn: () => Promise<TT>): Promise<TT> {
          return runNonLlm(trace, "EMBEDDING", model, model, fn);
        },
        async score(_params: CreateScoreParams): Promise<void> {
          // Scores are evaluation records, not trace observations.
          // Local capture ignores them — they do not contaminate the trace.
        },
        createSpan(spanOptions: Omit<CreateSpanParams, "project" | "run_id">): string {
          const spanId = makeSpanId("span");
          pending.set(spanId, {
            spanId,
            parentSpanId: spanOptions.parent_call_id ?? rootSpanId,
            type: observationTypeFor(spanOptions.observation_type),
            name: spanOptions.step_name ?? "span",
            startedAtIso: new Date(monotonicNowMs()).toISOString(),
            startedAtMs: monotonicNowMs(),
            model: spanOptions.model,
            input: spanOptions.input,
          });
          return spanId;
        },
        endSpan(spanId: string, endParams?: Omit<EndSpanParams, "id">): void {
          complete(spanId, endParams);
        },
      };

      // Run the execution. Always end the root and freeze the snapshot.
      let value: T;
      try {
        value = await execute(trace);
        trace.endRoot();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        trace.endRoot({ status_message: message, level: "ERROR", metadata: { failed: true } });
        throw error;
      }

      // Any spans never ended (still pending) are dropped — an incomplete
      // execution snapshot would mislead assertions. The root is always ended.
      const snapshot = buildSnapshot();

      return { value, traceId, snapshot };
    },
  };
  return recorder;
}

/** Run a non-LLM span (retriever/chain/agent/etc.) through the local trace context. */
async function runNonLlm<TT>(
  trace: AgentTaskTraceContext,
  type: NonNullable<CreateSpanParams["observation_type"]>,
  name: string,
  stepName: string,
  fn: () => Promise<TT>,
  rootSpanId: string = trace.rootSpanId,
): Promise<TT> {
  const spanId = trace.createSpan({
    task_id: `${type.toLowerCase()}.${name}`,
    step_name: stepName,
    model: name,
    observation_type: type,
    parent_call_id: rootSpanId,
  });
  const start = monotonicNowMs();
  try {
    const result = await fn();
    trace.endSpan(spanId, { latency_ms: round3(monotonicNowMs() - start), output: toOutput(result) });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trace.endSpan(spanId, { latency_ms: round3(monotonicNowMs() - start), status_message: message, level: "ERROR" });
    throw error;
  }
}

function toOutput(result: unknown): Record<string, unknown> {
  if (typeof result === "object" && result !== null) {
    return result as Record<string, unknown>;
  }
  return { value: result };
}

function extractText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output != null && typeof output === "object" && "text" in output) {
    const text = (output as { text: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

/** Derive capabilities honestly from what the recorded observations carry. */
function deriveCapabilities(
  observations: readonly TraceProjectionObservation[],
): TraceProjectionCapabilities {
  const hasType = (t: TraceProjectionObservation["type"]) =>
    observations.some((o) => o.type === t);
  const hasMessages = observations.some(
    (o) => o.type === "GENERATION" && o.messages && o.messages.length > 0,
  );
  return {
    messages: hasMessages ? "available" : "unavailable",
    tools: hasType("TOOL") ? "available" : "unavailable",
    errors: observations.some((o) => o.status === "error") ? "available" : "unavailable",
    // Local capture always uses a real clock, so timing is genuinely available.
    timing: "available",
    skills: hasType("SKILL") ? "available" : "unavailable",
    subagents: hasType("AGENT") ? "available" : "unavailable",
  };
}
