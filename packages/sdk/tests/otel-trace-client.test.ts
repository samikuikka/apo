import { describe, it, expect } from "vitest";

const AUTH = `Basic ${btoa("pk-apo-6b40e8e4-fca6-4d9e-a97a-3421141a3845:sk-apo-71837c48-d891-4b98-b977-a292d308039b")}`;

// These tests use the real backend on :8000.
// Run with: APO_E2E=1 npx vitest run tests/otel-trace-client.test.ts
describe.skipIf(!process.env.APO_E2E)("OTel agent-task trace client (SPEC-129 §7)", () => {
  it("traceRun provides context with runId and rootSpanId", async () => {
    const { createOtelAgentTaskTraceClient } = await import(
      "../src/agent-task/otel-trace-client.ts"
    );
    const client = createOtelAgentTaskTraceClient({
      endpoint: "http://localhost:8000",
      project: "example-service-py",
      headers: { Authorization: AUTH },
    });

    const result = await client.traceRun(
      { project: "example-service-py", flow_name: "client-test", task_id: "test-task" },
      async (trace) => {
        expect(trace.runId).toBeDefined();
        expect(trace.rootSpanId).toBeDefined();
        expect(trace.runId.length).toBe(32);
        return 42;
      },
    );

    expect(result).toBe(42);
  }, 15000);

  it("traceRun step creates child spans", async () => {
    const { createOtelAgentTaskTraceClient } = await import(
      "../src/agent-task/otel-trace-client.ts"
    );
    const client = createOtelAgentTaskTraceClient({
      endpoint: "http://localhost:8000",
      project: "example-service-py",
      headers: { Authorization: AUTH },
    });

    const result = await client.traceRun(
      { project: "example-service-py", flow_name: "step-test" },
      async (trace) => {
        return await trace.step({ step_name: "test-step" }, async (spanId) => {
          expect(spanId).toBeDefined();
          return "step-result";
        });
      },
    );

    expect(result).toBe("step-result");
  }, 15000);

  it("traceRun propagates errors", async () => {
    const { createOtelAgentTaskTraceClient } = await import(
      "../src/agent-task/otel-trace-client.ts"
    );
    const client = createOtelAgentTaskTraceClient({
      endpoint: "http://localhost:8000",
      project: "example-service-py",
      headers: { Authorization: AUTH },
    });

    await expect(
      client.traceRun(
        { project: "example-service-py", flow_name: "error-test" },
        async () => { throw new Error("test error"); },
      ),
    ).rejects.toThrow("test error");
  }, 15000);

  it("traceTool creates a TOOL span", async () => {
    const { createOtelAgentTaskTraceClient } = await import(
      "../src/agent-task/otel-trace-client.ts"
    );
    const client = createOtelAgentTaskTraceClient({
      endpoint: "http://localhost:8000",
      project: "example-service-py",
      headers: { Authorization: AUTH },
    });

    const result = await client.traceRun(
      { project: "example-service-py", flow_name: "tool-test" },
      async (trace) => {
        return await trace.traceTool("search", { query: "test" }, async () => {
          return { results: ["a"] };
        });
      },
    );

    expect(result).toEqual({ results: ["a"] });
  }, 15000);
});
