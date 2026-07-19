import { describe, it, expect, afterEach } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { context, trace } from "@opentelemetry/api";

/**
 * W3C propagation tests use a test tracer + in-memory exporter. The context
 * manager (required for nested/propagated spans) is set up directly. This
 * avoids the official OTLP exporter's Node-http transport, which cannot be
 * mocked via globalThis.fetch.
 */
describe("W3C trace context propagation", () => {
  let contextManager: AsyncHooksContextManager;

  afterEach(() => {
    try { contextManager?.disable(); } catch { /* noop */ }
    try { context.disable(); } catch { /* noop */ }
    try { trace.disable(); } catch { /* noop */ }
  });

  function setup() {
    contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    return { tracer: provider.getTracer("w3c-test"), exporter };
  }

  it("injectTraceparent produces a valid W3C header", async () => {
    const { withApoTrace, injectTraceparent } = await import("../src/otel/index.ts");
    const { tracer } = setup();

    await withApoTrace({ name: "upstream-op" }, tracer, async (_span) => {
      const headers = injectTraceparent();
      expect(headers.traceparent).toBeDefined();
      // W3C format: version-traceid-spanid-flags (00-<32hex>-<16hex>-<2hex>)
      expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    });
  });

  it("extractTraceparent creates a child span linked to the upstream trace", async () => {
    const { withApoTrace, injectTraceparent, extractTraceparent } = await import(
      "../src/otel/index.ts"
    );
    const { tracer, exporter } = setup();

    let upstreamTraceId = "";
    let upstreamHeaders: Record<string, string> = {};

    await withApoTrace({ name: "upstream" }, tracer, async (span) => {
      upstreamTraceId = span.spanContext().traceId;
      upstreamHeaders = injectTraceparent();
    });

    await extractTraceparent(upstreamHeaders, tracer, async (span) => {
      const downstreamTraceId = span.spanContext().traceId;
      expect(downstreamTraceId).toBe(upstreamTraceId);
    });

    // The downstream span shares the upstream trace id.
    const traceIds = new Set(exporter.getFinishedSpans().map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);
  });

  it("extractTraceparent with no header creates a new root span", async () => {
    const { extractTraceparent } = await import("../src/otel/index.ts");
    const { tracer } = setup();

    // No traceparent header → should create a new root span (not crash)
    await extractTraceparent({}, tracer, async (span) => {
      expect(span).toBeDefined();
      expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    });
  });
});
