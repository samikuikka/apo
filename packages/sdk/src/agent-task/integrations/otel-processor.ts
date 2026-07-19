/**
 * ApoSpanProcessor — an OpenTelemetry SpanProcessor that routes GenAI spans
 * into apo's Flow.
 *
 * This is the OTel-native tracing path. After calling {@link registerApoTracing},
 * any SDK that emits OTel spans (Vercel AI SDK, OpenAI Agents SDK, etc.)
 * will be traced automatically — no per-SDK wrapper needed.
 *
 * The processor is global, but run isolation is maintained via
 * {@link AsyncLocalStorage}: {@link getActiveApoRun} returns the current
 * run's trace context, so each span is routed to the correct run's FlowTee.
 *
 * **Design: eager creation, deferred completion.** The apo span is created
 * at `onStart` (when initial attributes like tool name and model are
 * available). The span is ended at `onEnd` with the final attributes
 * (results, tokens, text). This gives correct ordering: parent spans
 * are created before children, matching the real call hierarchy.
 *
 * @module
 */

import { getActiveApoRun } from "./run-context.ts";
import {
  translateOtelSpan,
  round3,
  monotonicNowMs,
  type TranslatedSpan,
} from "./otel-translate.ts";

// ── minimal OTel type shapes (no runtime dependency on @opentelemetry/api) ──

interface OTelSpanContext {
  spanId: string;
  traceId: string;
  traceFlags: number;
}

interface OTelSpanStatus {
  code: number;
  message?: string;
}

interface OTelReadableSpan {
  name: string;
  spanContext(): OTelSpanContext;
  parentSpanContext?: OTelSpanContext;
  attributes: Record<string, unknown>;
  status: OTelSpanStatus;
  duration: [number, number];
  startTime: [number, number];
  ended: boolean;
}

interface OTelSpan extends OTelReadableSpan {
  setAttribute(key: string, value: unknown): this;
  setAttributes(attributes: Record<string, unknown>): this;
  setStatus(status: OTelSpanStatus): this;
  recordException(exception: unknown): void;
  updateName(name: string): this;
  end(endTime?: unknown): void;
  isRecording(): boolean;
}

interface OTelContext {
  getValue(key: symbol): unknown;
  setValue(key: symbol, value: unknown): OTelContext;
  deleteValue(key: symbol): OTelContext;
}

interface OTelSpanProcessorLifecycle {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Tracks an active span: the apo span ID, the OTel span name, and the
 * start timestamp for latency calculation.
 */
interface TrackedSpan {
  apoSpanId: string;
  otelSpanName: string;
  startedAt: number;
}

/**
 * A SpanProcessor that translates GenAI OTel spans into apo observations.
 *
 * Spans are created at `onStart` (eager) and completed at `onEnd`
 * (deferred). This gives correct parent/child ordering — parent spans
 * are created before their children, matching the real call hierarchy.
 *
 * If a span isn't load-bearing (not a GenAI tool/generation span), no
 * apo span is created.
 */
export class ApoSpanProcessor implements OTelSpanProcessorLifecycle {
  private spanMap = new Map<string, TrackedSpan>();

  onStart(span: OTelSpan, _parentContext: OTelContext): void {
    const run = getActiveApoRun();
    if (!run) return;

    // Quick check: is this span potentially load-bearing?
    // At onStart, the AI SDK has already set the initial attributes
    // (ai.toolCall.name, ai.toolCall.args for tool spans; ai.model.id
    // for generation spans). So we CAN translate now.
    const translated = translateOtelSpan(span.name, {
      attributes: span.attributes ?? {},
      status: { code: 0 }, // no error at start
    });
    if (!translated) return; // not load-bearing — skip

    // Resolve parent: check if the parent OTel span has an apo mapping
    const parentOtelId = span.parentSpanContext?.spanId;
    const parentTracked = parentOtelId ? this.spanMap.get(parentOtelId) : undefined;
    const parentApoId = parentTracked?.apoSpanId || run.parentSpanId || run.trace.rootSpanId;

    // Create the apo span eagerly (at start time)
    const apoSpanId = run.trace.createSpan({
      task_id: run.taskId ?? "otel-trace",
      parent_call_id: parentApoId,
      step_name: translated.stepName,
      model: translated.model ?? translated.stepName,
      observation_type: translated.observationType,
      ...(translated.input ? { input: translated.input } : {}),
      metadata: {
        ...(run.taskId ? { taskId: run.taskId } : {}),
        ...(run.turnNumber !== undefined ? { turnNumber: run.turnNumber } : {}),
        source: "otel-processor",
      },
    });

    this.spanMap.set(span.spanContext().spanId, {
      apoSpanId,
      otelSpanName: span.name,
      startedAt: monotonicNowMs(),
    });
  }

  onEnd(span: OTelReadableSpan): void {
    const otelId = span.spanContext().spanId;
    const tracked = this.spanMap.get(otelId);
    if (!tracked) return; // wasn't tracked (not load-bearing or outside run)
    this.spanMap.delete(otelId);

    const run = getActiveApoRun();
    if (!run) return;

    // Re-translate with final attributes (results, text, tokens set during execution)
    const translated = translateOtelSpan(tracked.otelSpanName, {
      attributes: span.attributes ?? {},
      status: span.status ?? { code: 0 },
    });

    const latency = round3(monotonicNowMs() - tracked.startedAt);

    // End the apo span with the final data
    run.trace.endSpan(tracked.apoSpanId, {
      latency_ms: latency,
      ...buildEndParams(translated),
    });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.spanMap.clear();
    return Promise.resolve();
  }

  /** Clear all state — for testing. */
  reset(): void {
    this.spanMap.clear();
  }
}

/**
 * Build the `endSpan` params from the translated span.
 * Handles observation-type-specific output shapes.
 */
function buildEndParams(t: TranslatedSpan | null): Record<string, unknown> {
  if (!t) return {};

  const params: Record<string, unknown> = {};

  if (t.promptTokens !== undefined) params.prompt_tokens = t.promptTokens;
  if (t.completionTokens !== undefined) params.completion_tokens = t.completionTokens;

  if (t.observationType === "GENERATION") {
    if (t.text !== undefined) {
      params.output = { text: t.text };
    }
  } else if (t.observationType === "TOOL") {
    if (t.output !== undefined) {
      params.output =
        t.output && typeof t.output === "object"
          ? (t.output as Record<string, unknown>)
          : { value: t.output };
    }
  }

  if (t.error) {
    params.level = "ERROR";
    if (t.errorMessage) params.status_message = t.errorMessage;
  }

  return params;
}
