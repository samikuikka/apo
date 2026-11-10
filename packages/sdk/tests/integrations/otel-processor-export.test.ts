import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import { ApoSpanProcessor } from "../../src/agent-task/integrations/otel-processor.ts";
import { withApoRunSync } from "../../src/agent-task/integrations/run-context.ts";
import type { AgentTaskTraceContext } from "../../src/agent-task/tracing.ts";
import type { CreateSpanParams, EndSpanParams } from "../../src/types.ts";

/**
 * The processor enriches the RAW span before export and creates the apo-side
 * span. Both halves must mark an AI SDK wrapper generation as an aggregate
 * (its doGenerate children are the physical requests): a wrapper counted as
 * a request double-counts every call in the backend's serving rollups.
 * Enrichment must run in onEnding; in onEnd, setAttribute is a silent no-op
 * because Span.end marks the span immutable before calling the hook.
 */

/** A trace context that records created and ended spans for assertions. */
function recordingTrace(): {
  ctx: AgentTaskTraceContext;
  creates: CreateSpanParams[];
  ends: EndSpanParams[];
} {
  const creates: CreateSpanParams[] = [];
  const ends: EndSpanParams[] = [];
  let n = 0;
  const ctx = {
    runId: "test-run",
    rootSpanId: "root",
    async step<T>(
      _opts: Record<string, unknown>,
      fn: (spanId: string) => Promise<T>,
    ): Promise<T> {
      return fn("step-span");
    },
    recordEvent(): string {
      return "event-span";
    },
    endRoot(): void {},
    async traceTool<T>(_n: string, _p: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async traceRetriever<T>(_q: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async traceChain<T>(_n: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async traceAgent<T>(_n: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async traceGuardrail<T>(_n: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async traceEmbedding<T>(_m: string, _i: unknown, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async score(): Promise<void> {},
    createSpan(params: CreateSpanParams): string {
      creates.push(params);
      n += 1;
      return `span-${n}`;
    },
    endSpan(spanId: string, params: EndSpanParams): void {
      ends.push({ ...params, id: spanId });
    },
  } as unknown as AgentTaskTraceContext;
  return { ctx, creates, ends };
}

describe("ApoSpanProcessor export enrichment", () => {
  it("marks an AI SDK wrapper generation aggregate on the raw span and the apo span", async () => {
    const { ctx, creates } = recordingTrace();
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new ApoSpanProcessor(), new SimpleSpanProcessor(exporter)],
    });

    withApoRunSync({ trace: ctx, taskId: "task-1" }, () => {
      const tracer = provider.getTracer("test");
      const span = tracer.startSpan("ai.generateText", {
        attributes: {
          "ai.model.id": "openai/gpt-5.6",
          "ai.telemetry.metadata.apo.llm.api_provider": "openrouter",
          "ai.telemetry.metadata.apo.llm.serving_host": "baseten",
        },
      });
      span.setAttribute("ai.response.text", "done");
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    // The aggregate marker and the declared identity must survive to the
    // exporter; in onEnd both were silent no-ops on the ended span.
    expect(spans[0].attributes["apo.llm.request_kind"]).toBe("aggregate");
    expect(spans[0].attributes["apo.llm.api_provider"]).toBe("openrouter");
    expect(spans[0].attributes["apo.llm.serving_host"]).toBe("baseten");

    // The apo-side span mirrors the aggregate classification.
    const wrapper = creates.find((c) => c.request_kind === "aggregate");
    expect(wrapper).toBeDefined();
    expect(wrapper?.observation_type).toBe("GENERATION");

    await provider.shutdown();
  });

  it("leaves plain provider generations as request evidence", async () => {
    const { ctx, creates } = recordingTrace();
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new ApoSpanProcessor(), new SimpleSpanProcessor(exporter)],
    });

    withApoRunSync({ trace: ctx, taskId: "task-1" }, () => {
      const tracer = provider.getTracer("test");
      const span = tracer.startSpan("chat.completions", {
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "gpt-5.6",
        },
      });
      span.end();
    });

    const wrappers = creates.filter((c) => c.request_kind === "aggregate");
    expect(wrappers).toHaveLength(0);

    await provider.shutdown();
  });
});
