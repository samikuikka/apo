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
 * run's trace context, so each span is routed to the correct run's trace.
 *
 * **Design: eager creation, deferred completion.** The apo span is created
 * at `onStart` (when initial attributes like tool name and model are
 * available). The span is ended at `onEnding` with the final attributes
 * (results, tokens, text). This gives correct ordering: parent spans
 * are created before children, matching the real call hierarchy.
 *
 * @module
 */

import { getActiveApoRun } from "./run-context.ts";
import {
  translateOtelSpan,
  servingFromTelemetryMetadata,
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

interface TrackedSpan {
  apoSpanId: string;
  otelSpanName: string;
  startedAt: number;
}

/** AI SDK wrapper spans: one logical generation whose doGenerate/doStream
 * children are the physical requests. Both the apo-side span and the raw
 * exported span must carry the aggregate marker for them. */
const _AI_SDK_WRAPPER_NAMES = new Set(["ai.generateText", "ai.streamText"]);

/**
 * Do not remove the parent-stamping built on this helper: the Vercel AI
 * SDK reports the serving model only on per-step doGenerate children,
 * which are not load-bearing, so re-attaching their report to the parent
 * is the only way the serving model reaches the exported span — the
 * backend reads gen_ai.response.model for pricing and model-drift
 * detection on OTel-native (non-wrapper) traces.
 */
function servedModelFrom(
  attributes: Record<string, unknown>,
): string | undefined {
  for (const key of ["ai.response.model", "gen_ai.response.model"]) {
    const value = attributes[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/**
 * A SpanProcessor that translates GenAI OTel spans into apo observations.
 *
 * Spans are created at `onStart` (eager) and completed at `onEnding`
 * (deferred, while the span is still mutable). This gives correct
 * parent/child ordering: parent spans are created before their children,
 * matching the real call hierarchy.
 *
 * If a span isn't load-bearing (not a GenAI tool/generation span), no
 * apo span is created.
 */
export class ApoSpanProcessor implements OTelSpanProcessorLifecycle {
  private spanMap = new Map<string, TrackedSpan>();
  private servedModelByParent = new Map<string, string>();
  private servingByParent = new Map<
    string,
    {
      apiProvider?: string;
      servingHost?: string;
      route?: string;
      serviceTier?: string;
    }
  >();

  onEnd(_span: OTelReadableSpan): void {
    // All work happens in onEnding, where the span is still mutable; by
    // onEnd the span is immutable and setAttribute is a no-op.
  }

  onStart(span: OTelSpan, _parentContext: OTelContext): void {
    const run = getActiveApoRun();
    if (!run) return;

    // At onStart the AI SDK has already set the initial attributes
    // (ai.toolCall.name, ai.toolCall.args for tool spans; ai.model.id
    // for generation spans), so translation can happen now.
    const translated = translateOtelSpan(span.name, {
      attributes: span.attributes ?? {},
      status: { code: 0 }, // no error at start
    });
    if (!translated) return; // not load-bearing — skip

    const parentOtelId = span.parentSpanContext?.spanId;
    const parentTracked = parentOtelId ? this.spanMap.get(parentOtelId) : undefined;
    const parentApoId = parentTracked?.apoSpanId || run.parentSpanId || run.trace.rootSpanId;

    const apoSpanId = run.trace.createSpan({
      task_id: run.taskId ?? "otel-trace",
      parent_call_id: parentApoId,
      step_name: translated.stepName,
      model: translated.model ?? translated.stepName,
      observation_type: translated.observationType,
      // An AI SDK wrapper generation is one logical operation over several
      // physical requests (its doGenerate/doStream children); without the
      // aggregate marker the rollups count the wrapper as a request too
      // and every call is counted twice.
      ...(_AI_SDK_WRAPPER_NAMES.has(span.name)
        ? { request_kind: "aggregate" as const }
        : {}),
      ...(translated.serving?.apiProvider
        ? { api_provider: translated.serving.apiProvider }
        : {}),
      ...(translated.serving?.servingHost
        ? { serving_host: translated.serving.servingHost }
        : {}),
      ...(translated.serving?.route ? { route: translated.serving.route } : {}),
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

  onEnding(span: OTelReadableSpan): void {
    const otelId = span.spanContext().spanId;

    // A per-step child reporting its serving model is the parent
    // generation's served model — remember it for the parent's end.
    const parentOtelId = span.parentSpanContext?.spanId;
    const served = servedModelFrom(span.attributes ?? {});
    if (parentOtelId && served) {
      this.servedModelByParent.set(parentOtelId, served);
    }
    // Same inheritance for serving identity: the AI SDK puts base telemetry
    // attributes (including the app-declared apo.llm.* metadata) on the
    // doGenerate/doStream children, not the wrapper the processor tracks.
    const declaredServing = servingFromTelemetryMetadata(span.attributes ?? {});
    if (parentOtelId && declaredServing) {
      this.servingByParent.set(parentOtelId, declaredServing);
    }

    // Own report first, then what a child reported for this span. A span
    // ends once, so claim its slot here: the processor is a singleton that
    // outlives runs, and an entry left for a span that ended untracked or
    // outside its run's context would never be removed.
    const servedForThis = served ?? this.servedModelByParent.get(otelId);
    this.servedModelByParent.delete(otelId);
    const servingForThis =
      declaredServing ?? this.servingByParent.get(otelId);
    this.servingByParent.delete(otelId);

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

    // The backend projects from the RAW exported span, so identity must
    // live on this span itself, not only the in-process apo view. This
    // runs in onEnding, BEFORE the span becomes immutable: setAttribute
    // inside onEnd is a silent no-op (Span.end sets _ended before calling
    // onEnd), so enrichment there never reaches the exporter.
    const raw = span as OTelReadableSpan & {
      setAttribute?: (key: string, value: string) => void;
    };
    if (servingForThis) {
      if (servingForThis.apiProvider) {
        raw.setAttribute?.("apo.llm.api_provider", servingForThis.apiProvider);
      }
      if (servingForThis.servingHost) {
        raw.setAttribute?.("apo.llm.serving_host", servingForThis.servingHost);
      }
      if (servingForThis.route) {
        raw.setAttribute?.("apo.llm.route", servingForThis.route);
      }
      if (servingForThis.serviceTier) {
        raw.setAttribute?.("apo.llm.service_tier", servingForThis.serviceTier);
      }
    }
    // A wrapper generation is one logical operation; its children are the
    // physical requests. The backend's rollups read this marker, and it
    // must land even without declared serving identity.
    if (_AI_SDK_WRAPPER_NAMES.has(tracked.otelSpanName)) {
      raw.setAttribute?.("apo.llm.request_kind", "aggregate");
    }

    run.trace.endSpan(tracked.apoSpanId, {
      latency_ms: latency,
      ...buildEndParams(translated),
      ...(servedForThis ? { served_model: servedForThis } : {}),
      ...(servingForThis?.apiProvider
        ? { api_provider: servingForThis.apiProvider }
        : {}),
      ...(servingForThis?.servingHost
        ? { serving_host: servingForThis.servingHost }
        : {}),
    });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.spanMap.clear();
    this.servedModelByParent.clear();
    this.servingByParent.clear();
    return Promise.resolve();
  }

  /** Clear all state — for testing. */
  reset(): void {
    this.spanMap.clear();
    this.servedModelByParent.clear();
    this.servingByParent.clear();
  }
}

function buildEndParams(t: TranslatedSpan | null): Record<string, unknown> {
  if (!t) return {};

  const params: Record<string, unknown> = {};

  if (t.promptTokens !== undefined) params.prompt_tokens = t.promptTokens;
  if (t.completionTokens !== undefined) params.completion_tokens = t.completionTokens;
  if (t.reasoningTokens !== undefined) params.reasoning_tokens = t.reasoningTokens;

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
