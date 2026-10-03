/**
 * Adapter capture mode — replay a harness session transcript into a live
 * Task Run.
 *
 * The adapter contract this serves: a harness that cannot emit OTel (Codex
 * CLI, plain Claude Code, anything that only writes a session JSONL) declares
 * its transcript on the session (`AdapterSession.transcript`), and the runner
 * calls {@link replayAdapterTranscript} after the turn loop. One call does
 * two things with the same parse:
 *
 * 1. **Local:** converts the translated spans into projection observations and
 *    returns them, so the runner can inject them into the local snapshot —
 *    `t.calledTool` / budget assertions work even on offline, unrecorded runs.
 * 2. **Remote:** when the run has a live trace id and backend credentials, the
 *    OTLP payload joins the run's trace (same traceId, interactions parented
 *    under the run root) and the backend projects it exactly like native OTel
 *    spans — the read-back snapshot the recorded path evaluates against is
 *    indistinguishable from an instrumented run.
 *
 * Failure semantics are strict on purpose: the adapter *declared* a
 * transcript, so a missing file or a failed export on a recorded run fails
 * the run loudly — otherwise checks would starve on a projection that
 * silently lacks the agent's activity.
 */

import { readFile } from "node:fs/promises";

import type { AdapterTranscriptCapture } from "../adapter/types.ts";
import { buildApoAuthHeaders } from "../auth-headers.ts";
import { exportOtlpTraces } from "./export.ts";
import { parseClaudeCodeTranscript } from "./claude-code.ts";
import { parseCodexTranscript } from "./codex.ts";
import { transcriptSessionToOtlp, type OtlpTracesPayload } from "./otlp.ts";
import type { ParsedTranscriptSession, TranscriptSource } from "./types.ts";
import type {
  TraceProjectionObservation,
  TraceProjectionUsage,
} from "../trace-projection/types.ts";
import { asRecord, asString } from "./parse-shared.ts";

export type ReplayAdapterTranscriptOptions = {
  /** The live run's root span id — replayed interactions nest under it. */
  rootSpanId: string;
  /**
   * The live trace id. Present only when the run has a real trace (a noop
   * trace context yields sentinel ids); when absent the replay stays local.
   */
  liveTraceId?: string;
  /** apo base URL (AGENT_TASK_TRACE_ENDPOINT). Required for remote export. */
  endpoint?: string;
};

export type TranscriptCaptureResult = {
  /** Projection observations for the replayed spans (already snapshot-sorted). */
  observations: TraceProjectionObservation[];
  /** Total OTLP spans the translation produced (observations + resource meta). */
  spanCount: number;
  /** Whether the payload was exported to the backend. */
  exported: boolean;
  /** Parser warnings (torn lines, unterminated turns). */
  warnings: string[];
  turns: number;
};

export async function replayAdapterTranscript(
  capture: AdapterTranscriptCapture,
  options: ReplayAdapterTranscriptOptions,
): Promise<TranscriptCaptureResult> {
  let content: string;
  try {
    content = await readFile(capture.path, "utf-8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Transcript capture failed: cannot read ${capture.source} session file at ${capture.path} (${reason})`,
    );
  }

  const session = parseTranscriptBySource(capture.source, content);
  // Same credential contract as the runner's own OTLP exporter (Basic for
  // API-key pairs, Bearer for attempt tokens) — resolved once, shared shape.
  const authHeaders = buildApoAuthHeaders();
  const remote =
    options.liveTraceId !== undefined &&
    options.endpoint !== undefined &&
    authHeaders !== undefined;

  // Both outputs derive from ONE translation so the exported spans and the
  // injected observations can never disagree.
  const payload = transcriptSessionToOtlp(session, {
    ...(remote ? { traceId: options.liveTraceId } : {}),
    parentSpanId: options.rootSpanId,
  });
  const spanCount = countSpans(payload);

  if (remote) {
    // Throws (after retries) on 4xx/5xx/network — deliberately: a recorded run
    // whose replay never landed would evaluate against a projection missing
    // all agent activity.
    await exportOtlpTraces(payload, { endpoint: options.endpoint!, headers: authHeaders! });
  }

  return {
    observations: observationsFromOtlpPayload(payload, session.source),
    spanCount,
    exported: remote,
    warnings: session.warnings,
    turns: session.turns.length,
  };
}

function parseTranscriptBySource(
  source: TranscriptSource,
  content: string,
): ParsedTranscriptSession {
  if (source === "claude-code") return parseClaudeCodeTranscript(content);
  return parseCodexTranscript(content);
}

function countSpans(payload: OtlpTracesPayload): number {
  let count = 0;
  for (const resourceSpans of payload.resourceSpans) {
    for (const scopeSpans of resourceSpans.scopeSpans) {
      count += scopeSpans.spans.length;
    }
  }
  return count;
}

// ── OTLP payload → projection observations ────────────────────────────────

type OtlpAttrMap = Map<string, string>;

function attrMap(span: { attributes: Array<{ key: string; value: unknown }> }): OtlpAttrMap {
  const map = new Map<string, string>();
  for (const attr of span.attributes) {
    const value = asRecord(attr.value);
    if (value === undefined) continue;
    const text = asString(value.stringValue) ?? asString(value.intValue);
    if (text !== undefined) map.set(attr.key, text);
  }
  return map;
}

function nanosToIso(nanos: string): string | undefined {
  if (nanos === "" || nanos === "0") return undefined;
  const ms = Number(BigInt(nanos) / BigInt(1_000_000));
  return new Date(ms).toISOString();
}

/**
 * Convert the translated OTLP payload into snapshot observations.
 *
 * Mirrors what the backend projector derives from the same attributes, so
 * local (offline) and canonical (read-back) snapshots agree: model from
 * `gen_ai.request.model`, messages from `gen_ai.*.messages`, tool identity
 * from `gen_ai.tool.*`, and provider-aware token families (Anthropic reports
 * input *net* of cache with separate buckets; OpenAI reports input *incl.*
 * cache — summing the input-side family must respect that difference).
 */
export function observationsFromOtlpPayload(
  payload: OtlpTracesPayload,
  source: TranscriptSource,
): TraceProjectionObservation[] {
  const observations: TraceProjectionObservation[] = [];

  for (const resourceSpans of payload.resourceSpans) {
    for (const scopeSpans of resourceSpans.scopeSpans) {
      for (const span of scopeSpans.spans) {
        observations.push(observationFromSpan(span, source));
      }
    }
  }

  // Snapshot contract: deterministic order by invocation time, then span id.
  observations.sort((a, b) => {
    const at = a.startedAt ?? "";
    const bt = b.startedAt ?? "";
    if (at !== bt) return at < bt ? -1 : 1;
    return a.spanId < b.spanId ? -1 : 1;
  });
  return observations;
}

function observationFromSpan(
  span: {
    spanId: string;
    parentSpanId?: string;
    name: string;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    attributes: Array<{ key: string; value: unknown }>;
  },
  source: TranscriptSource,
): TraceProjectionObservation {
  const attrs = attrMap(span);
  const startedAt = nanosToIso(span.startTimeUnixNano);
  const endedAt = nanosToIso(span.endTimeUnixNano);
  const startedMs = startedAt !== undefined ? Date.parse(startedAt) : undefined;
  const endedMs = endedAt !== undefined ? Date.parse(endedAt) : undefined;

  const type = attrs.get("apo.observation.type");
  const inputMessages = parseJsonAttr(attrs.get("gen_ai.input.messages"));
  const outputMessages = parseJsonAttr(attrs.get("gen_ai.output.messages"));

  const observation: TraceProjectionObservation = {
    spanId: span.spanId,
    type: isObservationType(type) ? type : "SPAN",
    name: span.name,
    status: "ok",
  };
  if (span.parentSpanId !== undefined) observation.parentSpanId = span.parentSpanId;
  if (startedAt !== undefined) observation.startedAt = startedAt;
  if (endedAt !== undefined) observation.endedAt = endedAt;
  if (startedMs !== undefined && endedMs !== undefined) {
    observation.durationMs = endedMs - startedMs;
  }
  const model = attrs.get("gen_ai.request.model");
  if (model !== undefined) observation.model = model;
  if (inputMessages !== undefined) observation.input = { messages: inputMessages };
  if (outputMessages !== undefined) observation.output = { messages: outputMessages };

  if (observation.type === "GENERATION") {
    // The snapshot's `messages` is the generation's assistant bubble — what
    // judges and message assertions read.
    const messages = Array.isArray(outputMessages) ? outputMessages : [];
    if (messages.length > 0) observation.messages = messages as TraceProjectionObservation["messages"];
    const usage = usageFromAttrs(attrs, source);
    if (usage !== undefined) observation.usage = usage;
  }

  if (observation.type === "TOOL") {
    const toolName = attrs.get("gen_ai.tool.name");
    if (toolName !== undefined) observation.toolName = toolName;
    const parameters = parseJsonAttr(attrs.get("gen_ai.tool.call.arguments"));
    if (parameters !== undefined) observation.toolParameters = parameters;
    const result = parseJsonAttr(attrs.get("gen_ai.tool.call.result"));
    if (result !== undefined) observation.toolResult = result;
  }

  return observation;
}

function usageFromAttrs(
  attrs: OtlpAttrMap,
  source: TranscriptSource,
): TraceProjectionUsage | undefined {
  const input = numberAttr(attrs.get("gen_ai.usage.input_tokens"));
  const output = numberAttr(attrs.get("gen_ai.usage.output_tokens"));
  if (input === undefined && output === undefined) return undefined;

  const cacheRead = numberAttr(attrs.get("gen_ai.usage.cache_read.input_tokens")) ?? 0;
  const cacheWrite = numberAttr(attrs.get("gen_ai.usage.cache_creation.input_tokens")) ?? 0;
  // Provider semantics decide whether the cache buckets are already inside
  // `input_tokens` (OpenAI) or reported alongside a net figure (Anthropic).
  // The backend's usage normalizer sums the input-side family after applying
  // the same distinction; this mirrors it for local snapshots.
  const inputTokens =
    input === undefined
      ? undefined
      : source === "claude-code"
        ? input + cacheRead + cacheWrite
        : input;

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
  };
}

function numberAttr(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseJsonAttr(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isObservationType(
  value: string | undefined,
): value is TraceProjectionObservation["type"] {
  return (
    value === "SPAN" ||
    value === "GENERATION" ||
    value === "TOOL" ||
    value === "AGENT" ||
    value === "SKILL" ||
    value === "CHAIN" ||
    value === "RETRIEVER" ||
    value === "EMBEDDING" ||
    value === "GUARDRAIL"
  );
}
