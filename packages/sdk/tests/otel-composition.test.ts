/**
 * SPEC-131 Milestone 5 tests: TS OTel composition.
 *
 * Proves the invariants the hardening targeted:
 *   - nested spans share a trace and carry the correct parent (Test Case 9)
 *   - a pre-existing host/global provider is not replaced (Test Case 10)
 *   - service.name / service.version / environment reach the resource (Test Case 11)
 *   - module state resets cleanly after shutdown
 *
 * Span creation/propagation is verified via an in-memory exporter on a test
 * provider (the standard OTel pattern). configureApoTelemetry's resource
 * attachment and host composition are verified by inspecting the provider it
 * builds. Real OTLP export is proven by the M6 end-to-end test.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { context, trace } from "@opentelemetry/api";

function resetOtel() {
  try { context.disable(); } catch { /* noop */ }
  try { trace.disable(); } catch { /* noop */ }
}

describe("SPEC-131 nested context propagation", () => {
  let contextManager: AsyncHooksContextManager;
  afterEach(() => {
    try { contextManager?.disable(); } catch { /* noop */ }
    resetOtel();
  });

  it("nested spans share a trace and the child's parent is the root", async () => {
    contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer("test");

    const mod = await import("../src/otel/index.ts");
    await mod.withApoTrace({ name: "root" }, tracer, async () => {
      await mod.withApoTrace({ name: "child" }, tracer, async () => "deep");
    });

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === "root");
    const child = spans.find((s) => s.name === "child");
    expect(root).toBeDefined();
    expect(child).toBeDefined();
    expect(child!.spanContext().traceId).toBe(root!.spanContext().traceId);
    expect(child!.parentSpanContext?.spanId).toBe(root!.spanContext().spanId);
  });
});

describe("SPEC-131 host-provider composition", () => {
  afterEach(resetOtel);

  it("a pre-existing global provider is not silently replaced", async () => {
    // Register a host provider with an in-memory exporter so we can prove the
    // GLOBAL tracer still routes to the host (not apo) after configure.
    const hostExporter = new InMemorySpanExporter();
    const hostProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(hostExporter)],
    });
    trace.setGlobalTracerProvider(hostProvider);

    const mod = await import("../src/otel/index.ts");
    const handle = await mod.configureApoTelemetry({
      takeOwnership: true,
      endpoint: "http://127.0.0.1:9/v1/traces",
      serviceName: "test-service",
      headers: {},
    });
    // apo's own provider is distinct from the host provider.
    expect(handle.provider).not.toBe(hostProvider);

    // A span created through the GLOBAL tracer must reach the HOST exporter,
    // proving apo did not replace the global provider (registerGlobal=false).
    const globalTracer = trace.getTracer("host-app");
    const span = globalTracer.startSpan("host-span");
    span.end();
    await hostProvider.forceFlush();
    const hostSpans = hostExporter.getFinishedSpans();
    expect(hostSpans.some((s) => s.name === "host-span")).toBe(true);
    await handle.shutdown();
  });
});

describe("SPEC-131 resource attributes", () => {
  afterEach(resetOtel);

  it("service.name, service.version, and environment reach the span resource", async () => {
    const mod = await import("../src/otel/index.ts");
    const handle = await mod.configureApoTelemetry({
      takeOwnership: true,
      endpoint: "http://127.0.0.1:9/v1/traces",
      serviceName: "test-service",
      serviceVersion: "1.2.3",
      environment: "test",
      headers: {},
    });

    // In OTel 2.x the resource is carried on each span created by the provider.
    const span = handle.tracer.startSpan("resource-check") as unknown as {
      resource?: { attributes?: Record<string, unknown> };
    };
    expect(span.resource?.attributes?.["service.name"]).toBe("test-service");
    expect(span.resource?.attributes?.["service.version"]).toBe("1.2.3");
    expect(span.resource?.attributes?.["deployment.environment"]).toBe("test");
    span.end?.();
    await handle.shutdown();
  });
});

describe("SPEC-131 module reset", () => {
  afterEach(resetOtel);

  it("a second configuration after shutdown can re-register globally", async () => {
    const mod = await import("../src/otel/index.ts");
    const first = await mod.configureApoTelemetry({
      takeOwnership: true,
      endpoint: "http://127.0.0.1:9/v1/traces",
      serviceName: "first",
      headers: {},
      registerGlobal: true,
    });
    await first.shutdown();

    // After shutdown, the global is freed, so a second registerGlobal
    // configuration must succeed and serve spans from the global API.
    const second = await mod.configureApoTelemetry({
      takeOwnership: true,
      endpoint: "http://127.0.0.1:9/v1/traces",
      serviceName: "second",
      headers: {},
      registerGlobal: true,
    });
    const span = trace.getTracer("global-reset-check").startSpan("reset-check") as unknown as {
      resource?: { attributes?: Record<string, unknown> };
      end?: () => void;
    };
    expect(span.resource?.attributes?.["service.name"]).toBe("second");
    span.end?.();
    await second.shutdown();
  });
});
