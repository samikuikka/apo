/**
 * OTel-backed agent-task trace client (SPEC-129 §7).
 *
 * Replaces the deprecated ``TraceTracker``-backed ``createAgentTaskTraceClient``
 * with one that uses standard OpenTelemetry spans exported via the canonical
 * OTLP receiver. The ``AgentTaskTraceContext`` interface is identical —
 * ``runTask.ts``, ``FlowTee``, integrations, and task-authoring code work
 * unchanged.
 *
 * Key differences from the TraceTracker path:
 *   - Spans are real OTel spans (``tracer.startSpan`` / ``span.end()``)
 *   - Scores are domain records via the score API (not sentinel ingestion events)
 *   - Run completion happens when the root span ends (OTel native)
 *   - Export goes through ``configureApoTelemetry``'s OTLP exporter
 *
 * SPEC-129 §7:
 *   1. The runner starts an active root span named ``apo.task.run`` and adds
 *      ``apo.task.id`` and ``apo.task.run.id``.
 *   2. Child framework spans inherit context normally.
 *   3. Completion happens when the root span ends.
 */

import { trace, context, type Span, type Tracer } from "@opentelemetry/api";
import { configureApoTelemetry, type ApoTelemetryHandle } from "../otel/index.ts";
import type {
  CreateSpanParams,
  EndSpanParams,
  TraceRunContext,
  TraceRunOptions,
  TraceStepOptions,
  TraceEventOptions,
  CreateScoreParams,
} from "../types.ts";

function monotonicNowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export type AgentTaskTraceClientConfig = {
  endpoint: string;
  project: string;
  authToken?: string;
  requirePersistence?: boolean;
  /** Auth headers for the OTLP exporter (Authorization: Basic/Bearer). */
  headers?: Record<string, string>;
};

interface ActiveSpan {
  span: Span;
  startedAt: number;
  model: string;
}

/**
 * Create an OTel-native agent-task trace client.
 *
 * Drop-in replacement for ``createAgentTaskTraceClient`` that uses
 * ``configureApoTelemetry`` instead of ``TraceTracker``.
 */
export function createOtelAgentTaskTraceClient(
  config: AgentTaskTraceClientConfig,
): {
  traceRun<T>(
    params: TraceRunOptions,
    fn: (trace: TraceRunContext) => Promise<T>,
  ): Promise<T>;
} {
  // Cache the provider across all client instances — OTel only allows one
  // global provider per process. Subsequent calls reuse the existing handle.
  let myHandle: ApoTelemetryHandle | null = null;

  async function ensureProvider(): Promise<Tracer> {
    if (!myHandle) {
      const headers = config.headers
        ?? (config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {});
      myHandle = await configureApoTelemetry({
        takeOwnership: true,
        endpoint: `${config.endpoint.replace(/\/$/, "")}/api/public/otel/v1/traces`,
        serviceName: "apo-agent-task",
        project: config.project,
        headers,
        processor: "simple",
        registerGlobal: true,
      });
    }
    return myHandle.tracer;
  }

  const activeSpans = new Map<string, ActiveSpan>();
  let activeTracer: Tracer | null = null;

  function createSpan(params: CreateSpanParams): string {
    if (!activeTracer) throw new Error("traceRun not started");
    const spanName = params.step_name || params.observation_type || "span";
    // Use startSpan which inherits the active context. The root span is
    // activated in traceRun via context.with(). Child spans created here
    // inherit whatever span is currently active — correct nesting.
    const span = activeTracer.startSpan(spanName);

    // Set attributes using GenAI semantic conventions so the backend
    // normalizer can extract input/output/tokens into structured fields.
    if (params.observation_type) {
      span.setAttribute("apo.observation.type", params.observation_type);
    }
    if (params.model) {
      span.setAttribute("gen_ai.request.model", params.model);
    }
    if (params.input) {
      // Use gen_ai.input.messages so the normalizer routes it to the call's
      // structured input field (rendered as chat bubbles in the dashboard).
      if (params.input.messages) {
        span.setAttribute("gen_ai.input.messages", JSON.stringify(params.input.messages));
      } else {
        span.setAttribute("gen_ai.input.messages", JSON.stringify([{
          role: "system",
          parts: [{ type: "text", content: JSON.stringify(params.input) }],
        }]));
      }
    }
    if (params.metadata) {
      span.setAttribute("apo.metadata", JSON.stringify(params.metadata));
    }

    const spanId = span.spanContext().spanId;
    activeSpans.set(spanId, {
      span,
      startedAt: monotonicNowMs(),
      model: params.model || "unknown",
    });
    return spanId;
  }

  function endSpan(params: EndSpanParams): void {
    const active = activeSpans.get(params.id);
    if (!active) {
      return;
    }

    const latency = params.latency_ms ?? round3(monotonicNowMs() - active.startedAt);
    active.span.setAttribute("latency_ms", latency);

    if (params.output !== undefined) {
      // Use gen_ai.output.messages so the normalizer routes it to the call's
      // structured output field (rendered as chat bubbles + "Correct" button).
      if (params.output.text) {
        active.span.setAttribute("gen_ai.output.messages", JSON.stringify([{
          role: "assistant",
          parts: [{ type: "text", content: String(params.output.text) }],
        }]));
      } else if (params.output.messages) {
        active.span.setAttribute("gen_ai.output.messages", JSON.stringify(params.output.messages));
      } else if (params.output.error) {
        active.span.setAttribute("gen_ai.output.messages", JSON.stringify([{
          role: "assistant",
          parts: [{ type: "text", content: String(params.output.error) }],
        }]));
      } else {
        active.span.setAttribute("gen_ai.output.messages", JSON.stringify([{
          role: "assistant",
          parts: [{ type: "text", content: JSON.stringify(params.output) }],
        }]));
      }
    }
    if (params.prompt_tokens !== undefined) {
      active.span.setAttribute("gen_ai.usage.input_tokens", params.prompt_tokens);
    }
    if (params.completion_tokens !== undefined) {
      active.span.setAttribute("gen_ai.usage.output_tokens", params.completion_tokens);
    }
    if (params.status_message) {
      active.span.setAttribute("apo.status_message", params.status_message);
    }
    if (params.level === "ERROR") {
      active.span.setStatus({ code: 2, message: params.status_message || "error" });
    }
    if (params.metadata) {
      active.span.setAttribute("apo.metadata", JSON.stringify(params.metadata));
    }

    active.span.end();
    activeSpans.delete(params.id);
  }

  return {
    async traceRun<T>(
      params: TraceRunOptions,
      fn: (trace: TraceRunContext) => Promise<T>,
    ): Promise<T> {
      const tracer = await ensureProvider();
      activeTracer = tracer;

      const project = params.project ?? config.project;
      const taskId = params.task_id ?? params.flow_name ?? "task";
      const flowName = params.flow_name ?? taskId;

      // Create the root span with apo.task attributes (SPEC-129 §7)
      const rootSpan = tracer.startSpan("apo.task.run");
      rootSpan.setAttribute("apo.observation.type", "AGENT");
      rootSpan.setAttribute("apo.run.flow_name", flowName);
      rootSpan.setAttribute("apo.run.task_id", taskId);
      if (params.version) {
        rootSpan.setAttribute("apo.run.version", params.version);
      }
      if (params.run_metadata) {
        rootSpan.setAttribute("apo.run.metadata", JSON.stringify(params.run_metadata));
      }
      if (params.tags?.length) {
        rootSpan.setAttribute("apo.run.tags", JSON.stringify(params.tags));
      }

      // SPEC-128/129 §7.1: the task-run claim attributes. The backend projector
      // reads `apo.task.run.id` from the root span and atomically links this
      // trace to AgentTaskRunDB.trace_run_id. The task run id arrives from any
      // of three sources (first wins): an explicit taskRunId on params, the
      // rootSpan.metadata claim key (set by buildTraceRunOptions), or
      // run_metadata.agent_task_run_id (set by the backend at launch time).
      const rootMeta = params.rootSpan?.metadata as Record<string, unknown> | undefined;
      const taskRunId =
        ((params as { taskRunId?: string }).taskRunId) ??
        (rootMeta?.["apo.task.run.id"] as string | undefined) ??
        (params.run_metadata?.["agent_task_run_id"] as string | undefined);
      if (taskRunId) {
        rootSpan.setAttribute("apo.task.id", taskId);
        rootSpan.setAttribute("apo.task.run.id", taskRunId);
      }

      const runId = rootSpan.spanContext().traceId;
      const rootSpanId = rootSpan.spanContext().spanId;
      activeSpans.set(rootSpanId, {
        span: rootSpan,
        startedAt: monotonicNowMs(),
        model: "trace",
      });

      let callCount = 1;
      let rootEnded = false;

      const traceContext: TraceRunContext = {
        runId,
        rootSpanId,
        async step<TStep>(
          options: TraceStepOptions,
          stepFn: (spanId: string) => Promise<TStep>,
        ): Promise<TStep> {
          const spanId = createSpan({
            ...options,
            project,
            task_id: options.task_id ?? taskId,
            run_id: runId,
            parent_call_id: options.parent_call_id ?? rootSpanId,
            flow_name: options.flow_name ?? flowName,
          });
          const startedAt = monotonicNowMs();
          const activeSpan = activeSpans.get(spanId);

          // Activate this span in context so nested step()/traceTool() calls
          // inside stepFn see it as their parent (correct nesting hierarchy).
          const ctxWithSpan = activeSpan
            ? trace.setSpan(context.active(), activeSpan.span)
            : context.active();

          try {
            const result = await context.with(ctxWithSpan, () => stepFn(spanId));
            endSpan({
              id: spanId,
              latency_ms: round3(monotonicNowMs() - startedAt),
              output: options.summarize?.(result),
              metadata: options.metadata,
            });
            callCount += 1;
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            endSpan({
              id: spanId,
              latency_ms: round3(monotonicNowMs() - startedAt),
              output: { error: message },
              status_message: message,
              level: "ERROR",
              metadata: { ...options.metadata, failed: true },
            });
            throw error;
          }
        },
        recordEvent(options: TraceEventOptions): string {
          const spanId = createSpan({
            ...options,
            project,
            task_id: options.task_id ?? taskId,
            run_id: runId,
            parent_call_id: options.parent_call_id ?? rootSpanId,
            flow_name: options.flow_name ?? flowName,
          });
          endSpan({
            id: spanId,
            latency_ms: options.latency_ms,
            output: options.output,
            metadata: options.metadata,
          });
          callCount += 1;
          return spanId;
        },
        endRoot(endParams?: Omit<EndSpanParams, "id">): void {
          if (rootEnded) return;
          endSpan({ id: rootSpanId, ...endParams });
          rootEnded = true;
        },
        // Non-LLM tracing helpers — these create spans through the same tracer
        async traceTool<TN>(name: string, params: Record<string, unknown>, fn: () => Promise<TN>): Promise<TN> {
          const spanId = createSpan({
            project, task_id: taskId, run_id: runId, parent_call_id: rootSpanId,
            flow_name: flowName, step_name: `tool ${name}`,
            observation_type: "TOOL", model: "unknown",
            input: params,
          });
          try {
            const result = await fn();
            endSpan({ id: spanId, output: result as Record<string, unknown> });
            callCount += 1;
            return result;
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            endSpan({ id: spanId, output: { error: msg }, status_message: msg, level: "ERROR" });
            throw error;
          }
        },
        async traceRetriever<TN>(query: string, fn: () => Promise<TN>): Promise<TN> {
          const spanId = createSpan({
            project, task_id: taskId, run_id: runId, parent_call_id: rootSpanId,
            flow_name: flowName, step_name: "retrieve", observation_type: "RETRIEVER",
            model: "unknown", input: { query },
          });
          try { const r = await fn(); endSpan({ id: spanId, output: r as Record<string, unknown> }); callCount += 1; return r; }
          catch (e) { const m = e instanceof Error ? e.message : String(e); endSpan({ id: spanId, output: { error: m }, level: "ERROR" }); throw e; }
        },
        async traceChain<TN>(name: string, fn: () => Promise<TN>): Promise<TN> {
          const spanId = createSpan({
            project, task_id: taskId, run_id: runId, parent_call_id: rootSpanId,
            flow_name: flowName, step_name: name, observation_type: "CHAIN", model: "unknown",
          });
          try { const r = await fn(); endSpan({ id: spanId, output: r as Record<string, unknown> }); callCount += 1; return r; }
          catch (e) { const m = e instanceof Error ? e.message : String(e); endSpan({ id: spanId, output: { error: m }, level: "ERROR" }); throw e; }
        },
        async traceAgent<TN>(name: string, fn: () => Promise<TN>): Promise<TN> {
          const spanId = createSpan({
            project, task_id: taskId, run_id: runId, parent_call_id: rootSpanId,
            flow_name: flowName, step_name: name, observation_type: "AGENT", model: "unknown",
          });
          try { const r = await fn(); endSpan({ id: spanId, output: r as Record<string, unknown> }); callCount += 1; return r; }
          catch (e) { const m = e instanceof Error ? e.message : String(e); endSpan({ id: spanId, output: { error: m }, level: "ERROR" }); throw e; }
        },
        async traceGuardrail<TN>(name: string, fn: () => Promise<TN>): Promise<TN> {
          const spanId = createSpan({
            project, task_id: taskId, run_id: runId, parent_call_id: rootSpanId,
            flow_name: flowName, step_name: name, observation_type: "GUARDRAIL", model: "unknown",
          });
          try { const r = await fn(); endSpan({ id: spanId, output: r as Record<string, unknown> }); callCount += 1; return r; }
          catch (e) { const m = e instanceof Error ? e.message : String(e); endSpan({ id: spanId, output: { error: m }, level: "ERROR" }); throw e; }
        },
        async traceEmbedding<TN>(model: string, input: unknown, fn: () => Promise<TN>): Promise<TN> {
          const spanId = createSpan({
            project, task_id: taskId, run_id: runId, parent_call_id: rootSpanId,
            flow_name: flowName, step_name: "embedding", observation_type: "EMBEDDING", model,
            input: { value: input },
          });
          try { const r = await fn(); endSpan({ id: spanId, output: r as Record<string, unknown> }); callCount += 1; return r; }
          catch (e) { const m = e instanceof Error ? e.message : String(e); endSpan({ id: spanId, output: { error: m }, level: "ERROR" }); throw e; }
        },
        async score(scoreParams: CreateScoreParams): Promise<void> {
          // SPEC-129 §5: Scores are domain records via the score API
          const { score: scoreFn } = await import("../otel/index.ts");
          const scoreHeaders = config.headers
            ?? (config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {});
          await scoreFn(
            { traceId: runId, ...scoreParams },
            { endpoint: config.endpoint, headers: scoreHeaders },
          );
        },
      };

      // Add createSpan/endSpan for the AgentTaskTraceContext interface
      const agentTaskContext = {
        ...traceContext,
        createSpan(options: Omit<CreateSpanParams, "project" | "run_id">): string {
          const spanId = createSpan({
            ...options,
            project,
            run_id: runId,
            task_id: options.task_id ?? taskId,
            flow_name: options.flow_name ?? flowName,
          });
          callCount += 1;
          return spanId;
        },
        endSpan(spanId: string, endParams?: Omit<EndSpanParams, "id">): void {
          endSpan({ id: spanId, ...endParams });
        },
      };

      // Activate the root span in the OTel context so child spans created via
      // createSpan() (which calls tracer.startSpan) automatically inherit it
      // as their parent. This is standard OTel context propagation — no manual
      // parent_span_id passing needed (SPEC-129 §7.4).
      return context.with(trace.setSpan(context.active(), rootSpan), async () => {
        let result: T | undefined;
        let runError: unknown;
        try {
          result = await fn(agentTaskContext);
          agentTaskContext.endRoot();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          agentTaskContext.endRoot({
            output: { error: message },
            status_message: message,
            level: "ERROR",
            metadata: { failed: true },
          });
          runError = error;
        }

        let flushError: unknown;
        if (myHandle) {
          try {
            await myHandle.forceFlush();
          } catch (error) {
            flushError = error;
          }
          await myHandle.shutdown();
          myHandle = null;
        }
        if (runError !== undefined) throw runError;
        if (flushError !== undefined && config.requirePersistence) {
          const detail = flushError instanceof Error
            ? flushError.message
            : String(flushError);
          throw new Error(`OTLP trace persistence failed: ${detail}`);
        }
        return result as T;
      });
    },
  };
}
