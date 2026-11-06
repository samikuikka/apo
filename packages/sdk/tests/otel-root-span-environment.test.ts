/**
 * The backend projector reads a trace's environment from the root span's
 * `apo.run.environment` attribute. `traceRun` must stamp it whenever the
 * caller passes one, so a batch labelled staging (via
 * `apo task run --environment`) does not end up with traces that say default.
 */
import { describe, expect, it, vi } from "vitest";
import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { createOtelAgentTaskTraceClient } from "../src/agent-task/otel-trace-client.ts";
import type { TraceRunOptions } from "../src/types.ts";

const captured = vi.hoisted(() => ({ exporter: undefined as InMemorySpanExporter | undefined }));

vi.mock("../src/otel/index.ts", async () => {
  const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = await import(
    "@opentelemetry/sdk-trace-base"
  );
  return {
    configureApoTelemetry: async () => {
      const exporter = new InMemorySpanExporter();
      captured.exporter = exporter;
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      return {
        tracer: provider.getTracer("test"),
        forceFlush: async () => {},
        shutdown: async () => {},
      };
    },
  };
});

async function exportedRootSpanAttributes(params: TraceRunOptions) {
  const client = createOtelAgentTaskTraceClient({
    endpoint: "http://127.0.0.1:9",
    project: "env-proj",
  });
  await client.traceRun(params, async () => "done");
  const root = captured.exporter?.getFinishedSpans().find((s) => s.name === "apo.task.run");
  if (!root) throw new Error("no apo.task.run root span exported");
  return root.attributes;
}

describe("root span environment attribute", () => {
  it("stamps apo.run.environment on the root span so the backend records the trace's environment", async () => {
    const attributes = await exportedRootSpanAttributes({
      project: "env-proj",
      flow_name: "env-flow",
      environment: "staging",
    });

    expect(attributes["apo.run.environment"]).toBe("staging");
  });

  it("leaves apo.run.environment unset when no environment is given", async () => {
    const attributes = await exportedRootSpanAttributes({
      project: "env-proj",
      flow_name: "env-flow",
    });

    expect(attributes["apo.run.environment"]).toBeUndefined();
  });
});
