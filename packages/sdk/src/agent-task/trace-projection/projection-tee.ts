/**
 * Projection tee — wraps a real {@link AgentTaskTraceContext} and records the
 * span lifecycle into a {@link TraceProjectionSnapshot} (SPEC-130 Track D).
 *
 * This is the FlowTee replacement. FlowTee recorded legacy `FlowEvent`s which
 * `snapshotFromFlow` converted to a snapshot. This tee records
 * `TraceProjectionObservation`s directly — same source-of-truth, no Flow
 * intermediate. It delegates every call to the wrapped context (the real OTel
 * client), so real OTel spans still export via OTLP. The snapshot is only the
 * local, in-process assertion surface.
 *
 * The recording logic mirrors `local-recorder.ts` but as a delegating wrapper
 * rather than a standalone context.
 */

import type { AgentTaskTraceContext } from "../tracing.ts";
import type {
  CreateSpanParams,
  EndSpanParams,
  TraceEventOptions,
  CreateScoreParams,
} from "../../types.ts";
import type {
  ObservationStatus,
  TraceProjectionCapabilities,
  TraceProjectionObservation,
  TraceProjectionSnapshot,
} from "./types.ts";

function monotonicNowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

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

function extractText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output != null && typeof output === "object" && "text" in output) {
    const text = (output as { text: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

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
    // Local capture records every span's status, so error evidence is always
    // available — the absence of error observations IS proof of no errors.
    errors: "available",
    timing: "available",
    skills: hasType("SKILL") ? "available" : "unavailable",
    subagents: hasType("AGENT") ? "available" : "unavailable",
  };
}

export interface ProjectionTee {
  /** The wrapped trace context — delegate all span calls to this. */
  trace: AgentTaskTraceContext;
  /** Freeze the current observations into an immutable snapshot. */
  getSnapshot(): TraceProjectionSnapshot;
}

/**
 * Wrap a real {@link AgentTaskTraceContext} so every span/step call is
 * delegated to it (real OTel export) while also recording observations for a
 * local projection snapshot. This replaces FlowTee + snapshotFromFlow.
 */
export function createProjectionTee(
  real: AgentTaskTraceContext,
): ProjectionTee {
  const observations: TraceProjectionObservation[] = [];
  const pending = new Map<string, PendingObservation>();
  // Map tee-issued span ids to the real context's span ids so endSpan can
  // resolve the real span it must close. Without this, createSpan discards
  // real.createSpan's return value and endSpan can never find the real span —
  // the span is never ended, never exported, and its usage is lost.
  const realIdByTeeId = new Map<string, string>();
  let spanCounter = 0;

  // Trace-level timing — captured at tee creation (root span start) and read
  // at snapshot time (root span end). Mirrors local-recorder.ts so that
  // TraceView.durationMs has the startedAt/endedAt pair it needs. Without
  // this, deriveCapabilities hard-codes timing:"available" but the trace
  // object carries no timestamps, so t.maxDurationMs sees undefined and
  // reports "timing evidence unavailable" despite every observation being
  // individually timestamped.
  const rootStartMs = monotonicNowMs();
  const rootStartIso = new Date(rootStartMs).toISOString();

  function complete(spanId: string, params: Omit<EndSpanParams, "id"> | undefined): void {
    const p = pending.get(spanId);
    if (!p) return;
    pending.delete(spanId);
    const endedAtMs = monotonicNowMs();
    const isError = params?.level === "ERROR";
    const status: ObservationStatus = isError ? "error" : "ok";

    const obs: TraceProjectionObservation = {
      spanId: p.spanId,
      type: p.type,
      name: p.name,
      startedAt: p.startedAtIso,
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: round3(endedAtMs - p.startedAtMs),
      status,
    };
    if (p.parentSpanId) obs.parentSpanId = p.parentSpanId;
    if (p.model) obs.model = p.model;
    if (isError && params?.status_message) obs.errorMessage = params.status_message;

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

    if (p.type === "GENERATION" && params?.output != null) {
      const text = extractText(params.output);
      if (text !== "") {
        obs.messages = [{ role: "assistant", content: text }];
      }
    }

    observations.push(obs);
  }

  function recordStart(opts: {
    step_name?: string | null;
    observation_type?: CreateSpanParams["observation_type"];
    parent_call_id?: string | null;
    model?: string | null;
    input?: unknown;
  }): string {
    spanCounter += 1;
    const spanId = `${real.rootSpanId}-${String(spanCounter).padStart(6, "0")}`;
    pending.set(spanId, {
      spanId,
      parentSpanId: opts.parent_call_id ?? real.rootSpanId,
      type: observationTypeFor(opts.observation_type),
      name: opts.step_name ?? "step",
      startedAtIso: new Date(monotonicNowMs()).toISOString(),
      startedAtMs: monotonicNowMs(),
      model: opts.model ?? undefined,
      input: opts.input,
    });
    return spanId;
  }

  // Delegate every method to `real`, recording observations alongside.
  const trace: AgentTaskTraceContext = {
    runId: real.runId,
    rootSpanId: real.rootSpanId,

    async step(opts, fn) {
      // Delegate to the real context so the OTel span is created. Record one
      // observation around the whole step.
      const obsSpanId = recordStart(opts);
      const start = monotonicNowMs();
      try {
        const result = await real.step(opts, fn);
        complete(obsSpanId, {
          latency_ms: round3(monotonicNowMs() - start),
          output: opts.summarize?.(result),
          metadata: opts.metadata,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        complete(obsSpanId, {
          latency_ms: round3(monotonicNowMs() - start),
          status_message: message,
          level: "ERROR",
          metadata: { ...opts.metadata, failed: true },
        });
        throw error;
      }
    },

    recordEvent(evOptions: TraceEventOptions): string {
      const spanId = recordStart(evOptions);
      complete(spanId, {
        latency_ms: evOptions.latency_ms,
        output: evOptions.output,
        metadata: evOptions.metadata,
      });
      try { real.recordEvent(evOptions); } catch { /* best-effort */ }
      return spanId;
    },

    endRoot(endParams) {
      try { real.endRoot(endParams); } catch { /* best-effort */ }
    },

    createSpan(spanOptions): string {
      // Generate our OWN unique span id for recording (the wrapped context
      // may return a constant in noop mode). Delegate to real for the OTel
      // export, but return our id so endSpan finds the pending observation.
      const spanId = recordStart(spanOptions);

      // Spans originating from the ApoSpanProcessor (which intercepts the AI
      // SDK's own OTel spans) must NOT be re-exported via real.createSpan —
      // the original span is already being exported by the OTLP exporter, so
      // creating a second one here would produce duplicate LoggedCallDB rows.
      const isFromOtelProcessor =
        (spanOptions.metadata as Record<string, unknown> | undefined)?.source === "otel-processor";

      if (!isFromOtelProcessor) {
        try {
          const realId = real.createSpan(spanOptions);
          // Remember the real id so endSpan can close the real span. Falls back
          // to the tee id when the real context returns nothing (noop mode).
          realIdByTeeId.set(spanId, realId);
        } catch { /* best-effort */ }
      }
      return spanId;
    },

    endSpan(spanId, endParams) {
      complete(spanId, endParams);
      const realId = realIdByTeeId.get(spanId) ?? spanId;
      realIdByTeeId.delete(spanId);
      try { real.endSpan(realId, endParams); } catch { /* best-effort */ }
    },

    async traceTool(name, params, fn) {
      return real.traceTool(name, params, fn);
    },
    async traceRetriever(query, fn) {
      return real.traceRetriever(query, fn);
    },
    async traceChain(name, fn) {
      return real.traceChain(name, fn);
    },
    async traceAgent(name, fn) {
      return real.traceAgent(name, fn);
    },
    async traceGuardrail(name, fn) {
      return real.traceGuardrail(name, fn);
    },
    async traceEmbedding(model, input, fn) {
      return real.traceEmbedding(model, input, fn);
    },
    async score(params: CreateScoreParams) {
      return real.score(params);
    },
  };

  return {
    trace,
    getSnapshot(): TraceProjectionSnapshot {
      const endMs = monotonicNowMs();
      return {
        schemaVersion: 1,
        projectionVersion: 1,
        source: "local",
        trace: {
          traceId: real.runId,
          startedAt: rootStartIso,
          endedAt: new Date(endMs).toISOString(),
          durationMs: round3(endMs - rootStartMs),
          complete: true,
        },
        capabilities: deriveCapabilities(observations),
        observations: [...observations],
      };
    },
  };
}
