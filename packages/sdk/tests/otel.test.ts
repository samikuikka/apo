import { describe, it, expect, afterEach } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { context, trace } from "@opentelemetry/api";

/**
 * The official OTLPTraceExporter uses Node's http module (not fetch), so unit
 * tests cannot mock it via globalThis.fetch. These tests verify span CREATION
 * and PROPAGATION using an in-memory exporter attached to a test provider —
 * the standard OTel unit-test pattern. Real OTLP export is proven by the M6
 * end-to-end integration test with a live server.
 */
describe("@apo/sdk/otel", () => {
  let contextManager: AsyncHooksContextManager;

  afterEach(() => {
    try { contextManager?.disable(); } catch { /* noop */ }
    try { context.disable(); } catch { /* noop */ }
    try { trace.disable(); } catch { /* noop */ }
  });

  /** A test tracer backed by an in-memory exporter so spans can be inspected. */
  function testTracer() {
    contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    return { tracer: provider.getTracer("test"), exporter, provider };
  }

  describe("configureApoTelemetry", () => {
    it("is exported and callable", async () => {
      const mod = await import("../src/otel/index.ts");
      expect(typeof mod.configureApoTelemetry).toBe("function");
    });

    it("returns a handle with a tracer", async () => {
      const mod = await import("../src/otel/index.ts");
      const handle = await mod.configureApoTelemetry({
        takeOwnership: true,
        endpoint: "http://127.0.0.1:9/v1/traces",
        serviceName: "test-service",
        headers: {},
      });
      expect(handle).toBeDefined();
      expect(handle.tracer).toBeDefined();
      expect(typeof handle.tracer.startSpan).toBe("function");
      expect(typeof handle.shutdown).toBe("function");
      // No spans were created, so shutdown should not block on export.
      await handle.shutdown();
    });
  });

  describe("withApoTrace", () => {
    it("is exported and callable", async () => {
      const mod = await import("../src/otel/index.ts");
      expect(typeof mod.withApoTrace).toBe("function");
    });

    it("creates a span and passes it to the function", async () => {
      const mod = await import("../src/otel/index.ts");
      const { tracer, exporter } = testTracer();

      const result = await mod.withApoTrace(
        { name: "test-operation" },
        tracer,
        async (span) => {
          expect(span).toBeDefined();
          expect(span.setAttribute).toBeDefined();
          return 42;
        },
      );

      expect(result).toBe(42);
      expect(exporter.getFinishedSpans()).toHaveLength(1);
    });

    it("propagates the function return value", async () => {
      const mod = await import("../src/otel/index.ts");
      const { tracer } = testTracer();

      const result = await mod.withApoTrace(
        { name: "echo" },
        tracer,
        async () => "hello",
      );

      expect(result).toBe("hello");
    });
  });

  describe("traceTool helper", () => {
    it("creates a TOOL span with gen_ai.tool.name", async () => {
      const mod = await import("../src/otel/index.ts");
      const { tracer, exporter } = testTracer();

      const result = await mod.traceTool(tracer, "search", { query: "test" }, async () => {
        return { results: ["a", "b"] };
      });

      expect(result).toEqual({ results: ["a", "b"] });
      const span = exporter.getFinishedSpans().find((s) => s.name.startsWith("tool"));
      expect(span).toBeDefined();
      expect(span!.attributes?.["gen_ai.tool.name"]).toBe("search");
    });
  });
});
