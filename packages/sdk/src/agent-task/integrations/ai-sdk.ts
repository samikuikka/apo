/**
 * Vercel AI SDK tracing integration for apo.
 *
 * Pass the result of {@link createApoTracer} to `generateText`'s
 * `experimental_telemetry` option. The AI SDK already emits OpenTelemetry
 * spans natively (e.g. `ai.toolCall`, `ai.generateText`); this tracer
 * intercepts them and translates them into apo trace spans. The FlowTee
 * picks up TOOL/GENERATION observations and builds the Flow that
 * `t.calledTool`, `t.noFailedActions`, and `t.messageIncludes` read.
 *
 * The adapter author writes zero manual span code.
 *
 * @example
 * ```ts
 * import { generateText } from "ai";
 * import { createApoTracer } from "@apo/sdk/agent-task";
 *
 * async sendUserTurn(turn, { trace, parentSpanId }) {
 *   const result = await generateText({
 *     model, system, messages, tools,
 *     experimental_telemetry: createApoTracer({ trace, parentSpanId }),
 *   });
 *   return { response: result.text };
 * }
 * ```
 *
 * @module
 */

import type { AgentTaskTraceContext } from "../tracing.ts";
import { extractTokenUsage } from "./token-usage.ts";

// ── OpenTelemetry-compatible types ───────────────────────────────────────
// We implement the subset of the OTel `Tracer` and `Span` interfaces that the
// Vercel AI SDK touches (verified from `ai@6` source: `recordSpan` uses
// `startActiveSpan`; the AI SDK also calls `startSpan` on the default tracer
// for some operations). We re-declare the structural shape here so the
// `experimental_telemetry: { tracer }` option type-checks against the AI
// SDK's `TelemetrySettings` without taking a runtime dep on `@opentelemetry/api`.

type OTelAttributeValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<string | number | boolean | null | undefined>;
type OTelAttributes = Record<string, OTelAttributeValue>;

interface OTelSpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
}

interface OTelSpanStatus {
  code: number; // 0 = UNSET, 1 = OK, 2 = ERROR
  message?: string;
}

interface OTelException {
  name: string;
  message: string;
  stack?: string;
}

/**
 * Minimal `Span` implementation. The AI SDK calls:
 * - `setAttributes` / `setAttribute` (tool result, response text)
 * - `setStatus` / `recordException` (errors)
 * - `end()` (finalises the span)
 *
 * Other methods (`addEvent`, `addLink`, `updateName`) are no-ops but must
 * exist on the object for structural type compatibility with the OTel `Span`
 * interface the AI SDK expects.
 */
interface ApoSpan {
  spanContext(): OTelSpanContext;
  setAttribute(key: string, value: OTelAttributeValue): this;
  setAttributes(attrs: OTelAttributes): this;
  addEvent(name: string, attributesOrStartTime?: unknown, startTime?: unknown): this;
  addLink(link: unknown): this;
  addLinks(links: unknown[]): this;
  setStatus(status: OTelSpanStatus): this;
  updateName(name: string): this;
  end(endTime?: unknown): void;
  isRecording(): boolean;
  recordException(exception: OTelException | string, time?: unknown): this;
}

/**
 * Minimal `Tracer` implementation. The AI SDK's `recordSpan` uses
 * `startActiveSpan(name, { attributes }, fn)`. We also implement
 * `startSpan(name, opts)` for structural compatibility — it returns a span
 * without invoking a callback, and the caller is responsible for `.end()`.
 */
interface ApoTracer {
  startSpan(name: string, options?: { attributes?: OTelAttributes }): ApoSpan;
  startActiveSpan<T>(
    name: string,
    options: { attributes?: OTelAttributes },
    fn: (span: ApoSpan) => Promise<T> | T,
  ): Promise<T>;
  startActiveSpan<T>(
    name: string,
    options: { attributes?: OTelAttributes },
    context: unknown,
    fn: (span: ApoSpan) => Promise<T> | T,
  ): Promise<T>;
  startActiveSpan<T>(
    name: string,
    fn: (span: ApoSpan) => Promise<T> | T,
  ): Promise<T>;
}

// ── helpers ──────────────────────────────────────────────────────────────

function safeParse(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function monotonicNowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const SPAN_ID_PREFIX = "ai-sdk-";
let spanCounter = 0;

function nextSpanId(): string {
  spanCounter += 1;
  return `${SPAN_ID_PREFIX}${spanCounter}`;
}

// ── createApoTracer ──────────────────────────────────────────────────────

export interface CreateApoTracerOptions {
  /** The tee'd trace context from `sendUserTurn`'s second argument. */
  trace: AgentTaskTraceContext;
  /** The parent span id for this turn (from `sendUserTurn`'s context). */
  parentSpanId?: string;
  /** Optional task id, surfaced in span metadata. */
  taskId?: string;
  /** Optional turn number, surfaced in span metadata. */
  turnNumber?: number;
}

/**
 * Build a `Tracer` compatible with the Vercel AI SDK's
 * `experimental_telemetry.tracer` option. The returned object satisfies the
 * shape `{ isEnabled: true, tracer }` so it can be passed directly to
 * `experimental_telemetry`.
 *
 * The AI SDK emits spans named `ai.generateText`, `ai.generateText.doGenerate`,
 * and `ai.toolCall`. We translate the load-bearing ones:
 *
 * - `ai.toolCall` → a TOOL span (so `t.calledTool(name)` works)
 * - `ai.generateText` → a GENERATION span (so `t.messageIncludes(text)` works)
 *   and error status → `t.noFailedActions()` catches it
 *
 * Other spans (`ai.generateText.doGenerate`, etc.) are ignored — the FlowTee
 * only cares about TOOL/AGENT/GENERATION observation types.
 */
export function createApoTracer(
  options: CreateApoTracerOptions,
): { isEnabled: true; tracer: ApoTracer } {
  const { trace, parentSpanId, taskId, turnNumber } = options;

  // The generation span id for the current turn. Once `ai.generateText`
  // creates it, subsequent `ai.toolCall` spans should nest under it (the
  // agent calls tools *during* generation), not under the turn span.
  // Without this, every tool renders as a sibling of `agent.generate`
  // instead of a child, flattening the trace hierarchy.
  let currentGenerationSpanId: string | undefined;

  /**
   * Build a live span that accumulates attributes and, on `.end()`,
   * calls `trace.createSpan` + `trace.endSpan` with the right observation type.
   */
  function makeLiveSpan(
    name: string,
    observationType: "TOOL" | "GENERATION",
    initialAttrs: OTelAttributes,
  ): ApoSpan {
    const stepName =
      observationType === "TOOL"
        ? String(initialAttrs["ai.toolCall.name"] ?? "unknown")
        : "agent.generate";

    const input =
      observationType === "TOOL"
        ? (safeParse(initialAttrs["ai.toolCall.args"]) as Record<string, unknown>)
        : undefined;

    const spanId = trace.createSpan({
      task_id: taskId ?? "ai-sdk",
      parent_call_id:
        observationType === "TOOL"
          ? (currentGenerationSpanId ?? parentSpanId ?? trace.rootSpanId)
          : (parentSpanId ?? trace.rootSpanId),
      step_name: stepName,
      model: String(initialAttrs["ai.model.id"] ?? "ai-sdk"),
      observation_type: observationType,
      ...(input !== undefined ? { input } : {}),
      metadata: {
        ...(turnNumber !== undefined ? { turnNumber } : {}),
        ...(taskId ? { taskId } : {}),
      },
    });

    // Record the generation span id so tool spans created after it nest
    // under it (tools are called during generation).
    if (observationType === "GENERATION") {
      currentGenerationSpanId = spanId;
    }

    const startedAt = monotonicNowMs();
    let pendingAttrs: OTelAttributes = { ...initialAttrs };
    let status: OTelSpanStatus = { code: 0 };
    let errored = false;
    let ended = false;

    const span: ApoSpan = {
      spanContext(): OTelSpanContext {
        return { traceId: trace.runId, spanId, traceFlags: 0 };
      },
      setAttribute(key: string, value: OTelAttributeValue): ApoSpan {
        pendingAttrs[key] = value;
        return span;
      },
      setAttributes(attrs: OTelAttributes): ApoSpan {
        Object.assign(pendingAttrs, attrs);
        return span;
      },
      addEvent(_name: string, _attributesOrStartTime?: unknown, _startTime?: unknown): ApoSpan {
        return span; // no-op — events aren't load-bearing for Flow assertions
      },
      addLink(_link: unknown): ApoSpan {
        return span;
      },
      addLinks(_links: unknown[]): ApoSpan {
        return span;
      },
      setStatus(s: OTelSpanStatus): ApoSpan {
        status = s;
        if (s.code === 2) errored = true;
        return span;
      },
      updateName(_name: string): ApoSpan {
        return span; // name was set at creation time
      },
      end(_endTime?: unknown): void {
        if (ended) return;
        ended = true;
        const latency = round3(monotonicNowMs() - startedAt);

        if (observationType === "TOOL") {
          const resultRaw = pendingAttrs["ai.toolCall.result"];
          const output = resultRaw !== undefined ? safeParse(resultRaw) : undefined;
          trace.endSpan(spanId, {
            ...(output !== undefined
              ? {
                  output:
                    output && typeof output === "object"
                      ? (output as Record<string, unknown>)
                      : { value: output },
                }
              : {}),
            latency_ms: latency,
            ...(errored ? { level: "ERROR" as const } : {}),
          });
        } else {
          const text = extractTextFromAttrs(pendingAttrs);
          const tokens = extractTokenUsage(pendingAttrs);
          trace.endSpan(spanId, {
            output: text !== undefined ? { text } : {},
            latency_ms: latency,
            ...tokens,
            ...(errored
              ? { level: "ERROR" as const, status_message: status.message }
              : {}),
          });
        }
      },
      isRecording(): boolean {
        return !ended;
      },
      recordException(exception: OTelException | string, _time?: unknown): ApoSpan {
        errored = true;
        const msg = typeof exception === "string" ? exception : exception.message;
        status = { code: 2, message: msg };
        return span;
      },
    };

    return span;
  }

  function makeNoopSpan(): ApoSpan {
    const noop: ApoSpan = {
      spanContext: () => ({ traceId: "", spanId: nextSpanId(), traceFlags: 0 }),
      setAttribute() {
        return noop;
      },
      setAttributes() {
        return noop;
      },
      addEvent() {
        return noop;
      },
      addLink() {
        return noop;
      },
      addLinks() {
        return noop;
      },
      setStatus() {
        return noop;
      },
      updateName() {
        return noop;
      },
      end() {},
      isRecording: () => false,
      recordException() {
        return noop;
      },
    };
    return noop;
  }

  const tracer: ApoTracer = {
    startSpan(name: string, opts?: { attributes?: OTelAttributes }): ApoSpan {
      const attrs = opts?.attributes ?? {};
      const isToolCall = name === "ai.toolCall";
      const isGeneration = name === "ai.generateText" || name === "ai.streamText";
      if (!isToolCall && !isGeneration) return makeNoopSpan();
      return makeLiveSpan(name, isToolCall ? "TOOL" : "GENERATION", attrs);
    },

    startActiveSpan<T>(
      name: string,
      optionsOrFn:
        | { attributes?: OTelAttributes }
        | ((span: ApoSpan) => Promise<T> | T),
      contextOrFn?: ((span: ApoSpan) => Promise<T> | T) | unknown,
      maybeFn?: (span: ApoSpan) => Promise<T> | T,
    ): Promise<T> {
      // Three overload shapes:
      //   (name, fn)                         → optionsOrFn is the fn
      //   (name, options, fn)                → contextOrFn is the fn
      //   (name, options, context, fn)       → maybeFn is the fn (context ignored)
      let opts: { attributes?: OTelAttributes };
      let fn: (span: ApoSpan) => Promise<T> | T;

      if (typeof optionsOrFn === "function") {
        opts = {};
        fn = optionsOrFn;
      } else if (typeof contextOrFn === "function") {
        opts = optionsOrFn;
        fn = contextOrFn as (span: ApoSpan) => Promise<T> | T;
      } else {
        opts = optionsOrFn;
        fn = maybeFn!;
      }
      const attrs = opts.attributes ?? {};
      const isToolCall = name === "ai.toolCall";
      const isGeneration = name === "ai.generateText" || name === "ai.streamText";

      if (!isToolCall && !isGeneration) {
        const noopSpan = makeNoopSpan();
        return Promise.resolve(fn(noopSpan)).then((result) => {
          noopSpan.end();
          return result;
        });
      }

      const span = makeLiveSpan(
        name,
        isToolCall ? "TOOL" : "GENERATION",
        attrs,
      );

      return Promise.resolve(fn(span))
        .then((result) => {
          span.end();
          return result;
        })
        .catch((error) => {
          span.setStatus({
            code: 2,
            message: error instanceof Error ? error.message : String(error),
          });
          span.recordException({
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
          });
          span.end();
          throw error;
        });
    },
  };

  return { isEnabled: true, tracer };
}

// ── internals ────────────────────────────────────────────────────────────

/**
 * The AI SDK sets the model's response text under various attribute keys
 * depending on the operation. Try the known ones.
 */
function extractTextFromAttrs(attrs: OTelAttributes): string | undefined {
  const candidates = [
    "ai.response.text",
    "ai.response.output",
    "ai.generateText.result",
  ];
  for (const key of candidates) {
    const val = attrs[key];
    if (typeof val === "string" && val.length > 0) {
      const parsed = safeParse(val);
      if (typeof parsed === "string") return parsed;
      return val;
    }
  }
  return undefined;
}
