import { describe, it, expect, afterEach } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { context, trace } from "@opentelemetry/api";

describe("TS SDK E2E - trace hierarchy via context propagation", () => {
  let contextManager: AsyncHooksContextManager;

  afterEach(() => {
    try { contextManager?.disable(); } catch { /* noop */ }
    try { context.disable(); } catch { /* noop */ }
    try { trace.disable(); } catch { /* noop */ }
  });

  it("nested withApoTrace calls share one trace ID", async () => {
    // Set up a real context manager + in-memory exporter so propagation can be
    // inspected without the official OTLP exporter's Node-http transport.
    contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer("e2e-test");

    const { withApoTrace } = await import("../src/otel/index.ts");

    const traceIds = new Set<string>();

    await withApoTrace(
      { name: "tid-check-root", observationType: "AGENT" },
      tracer,
      async (rootSpan) => {
        traceIds.add(rootSpan.spanContext().traceId);
        await withApoTrace(
          { name: "tid-check-child", observationType: "GENERATION" },
          tracer,
          async (childSpan) => {
            traceIds.add(childSpan.spanContext().traceId);
          },
        );
      },
    );

    // Both spans should share one trace ID (context propagation working)
    expect(traceIds.size).toBe(1);
    expect(exporter.getFinishedSpans()).toHaveLength(2);
  });
});
