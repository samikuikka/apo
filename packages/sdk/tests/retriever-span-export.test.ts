/**
 * A retrieval exported through the real OTel trace client. Recorded runs
 * evaluate the backend's canonical projection, so the query and documents
 * must reach ingestion as structured fields: gen_ai.tool.call.arguments
 * (tool_parameters) and gen_ai.tool.call.result (tool_result). Exported as
 * chat messages, the documents never landed and every retrieval assertion
 * read unsupported on a recorded run.
 */
import { describe, expect, it, vi } from "vitest";
import type { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { createOtelAgentTaskTraceClient } from "../src/agent-task/otel-trace-client.ts";

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

describe("retriever span export", () => {
  it("exports the query and documents on the tool channels, not as chat messages", async () => {
    const documents = [{ id: "handbook-vacation#p1", score: 0.9, content: "25 days" }];
    const client = createOtelAgentTaskTraceClient({
      endpoint: "http://127.0.0.1:9",
      project: "retriever-span-export",
    });
    await client.traceRun({ project: "retriever-span-export", flow_name: "rag" }, (trace) =>
      trace.traceRetriever("vacation days", async () => ({ documents })),
    );

    const spans = captured.exporter?.getFinishedSpans() ?? [];
    const span = spans.find((s) => s.attributes["apo.observation.type"] === "RETRIEVER");
    expect(span, `retriever span among ${spans.map((s) => s.name).join(", ")}`).toBeDefined();
    const attributes = span!.attributes;
    expect(JSON.parse(String(attributes["gen_ai.tool.call.arguments"]))).toEqual({ query: "vacation days" });
    expect(JSON.parse(String(attributes["gen_ai.tool.call.result"]))).toEqual({ documents });
    expect(attributes["gen_ai.input.messages"]).toBeUndefined();
    expect(attributes["gen_ai.output.messages"]).toBeUndefined();
    expect(attributes["gen_ai.tool.name"], "a retrieval is not a named tool").toBeUndefined();
  });
});
