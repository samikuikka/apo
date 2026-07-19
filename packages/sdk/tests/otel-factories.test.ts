import { context, trace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";

import {
  configureApoTelemetry,
  createApoSpanProcessor,
  createApoTraceExporter,
} from "../src/otel/index.ts";

afterEach(() => {
  context.disable();
  trace.disable();
});

describe("host-owned OTel composition", () => {
  it("returns official exporter and processor implementations", () => {
    const exporter = createApoTraceExporter({
      endpoint: "http://127.0.0.1:9/v1/traces",
      headers: { Authorization: "Bearer test" },
    });
    const batch = createApoSpanProcessor({
      endpoint: "http://127.0.0.1:9/v1/traces",
      headers: {},
    });
    const simple = createApoSpanProcessor({
      endpoint: "http://127.0.0.1:9/v1/traces",
      headers: {},
      processor: "simple",
    });

    expect(exporter.constructor.name).toBe("OTLPTraceExporter");
    expect(batch).toBeInstanceOf(BatchSpanProcessor);
    expect(simple).toBeInstanceOf(SimpleSpanProcessor);
  });

  it("can be installed when the host constructs its provider", async () => {
    const processor = createApoSpanProcessor({
      endpoint: "http://127.0.0.1:9/v1/traces",
      headers: {},
      processor: "simple",
    });
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });

    expect(provider.getTracer("host")).toBeDefined();
    await provider.shutdown();
  });
});

describe("standalone telemetry ownership", () => {
  it("does not disable a host context manager during shutdown", async () => {
    const hostContext = new AsyncHooksContextManager().enable();
    expect(context.setGlobalContextManager(hostContext)).toBe(true);
    const key = Symbol("host-context-key");
    const handle = await configureApoTelemetry({
      takeOwnership: true,
      endpoint: "http://127.0.0.1:9/v1/traces",
      serviceName: "standalone-with-host-context",
      headers: {},
    });

    await handle.shutdown();

    const value = await context.with(
      context.active().setValue(key, "still-active"),
      async () => {
        await Promise.resolve();
        return context.active().getValue(key);
      },
    );
    expect(value).toBe("still-active");
    hostContext.disable();
  });

  it("does not disable a host global provider when registration is refused", async () => {
    const hostExporter = new InMemorySpanExporter();
    const hostProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(hostExporter)],
    });
    expect(trace.setGlobalTracerProvider(hostProvider)).toBe(true);
    const handle = await configureApoTelemetry({
      takeOwnership: true,
      endpoint: "http://127.0.0.1:9/v1/traces",
      serviceName: "standalone-with-host-provider",
      headers: {},
      registerGlobal: true,
    });

    await handle.shutdown();
    trace.getTracer("host-after-apo").startSpan("host-still-active").end();
    await hostProvider.forceFlush();

    expect(hostExporter.getFinishedSpans().map((span) => span.name))
      .toContain("host-still-active");
    await hostProvider.shutdown();
  });

  it("rejects misleading post-construction provider composition", async () => {
    const provider = new BasicTracerProvider();
    await expect(configureApoTelemetry({
      takeOwnership: true,
      endpoint: "http://127.0.0.1:9/v1/traces",
      serviceName: "invalid-host-composition",
      headers: {},
      provider,
    })).rejects.toThrow("createApoSpanProcessor");
    await provider.shutdown();
  });

  it("keeps shared context alive when handles shut down independently", async () => {
    const first = await configureApoTelemetry({
      takeOwnership: true,
      endpoint: "http://127.0.0.1:9/v1/traces",
      serviceName: "first-owner",
      headers: {},
    });
    const second = await configureApoTelemetry({
      takeOwnership: true,
      endpoint: "http://127.0.0.1:9/v1/traces",
      serviceName: "second-owner",
      headers: {},
    });
    await first.shutdown();

    const key = Symbol("second-handle-context");
    const value = await context.with(
      context.active().setValue(key, "active"),
      async () => {
        await Promise.resolve();
        return context.active().getValue(key);
      },
    );
    expect(value).toBe("active");
    await second.shutdown();
  });
});
