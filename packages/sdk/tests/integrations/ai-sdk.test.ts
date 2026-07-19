import { describe, it, expect } from "vitest";
import { createProjectionTee } from "../../src/agent-task/trace-projection/projection-tee.ts";
import type { AgentTaskTraceContext } from "../../src/agent-task/tracing.ts";
import { createApoTracer } from "../../src/agent-task/integrations/ai-sdk.ts";
import { defineCheck, resetFlowChecks, runTraceChecks } from "../../src/agent-task/checks/flow-runner.ts";

// Build a projection-tee wrapping a no-op trace context. The tee captures
// createSpan/endSpan calls into a TraceProjectionSnapshot, which is exactly
// what runTask does (the FlowTee replacement).
function makeTee() {
  const noop: AgentTaskTraceContext = {
    runId: "test-run",
    rootSpanId: "root",
    async step<T>(_opts: { step_name: string }, fn: (_spanId: string) => Promise<T>): Promise<T> {
      return fn("step-span");
    },
    recordEvent(): string {
      return "event-span";
    },
    endRoot(): void {},
    async traceTool<T>(_name: string, _params: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async traceRetriever<T>(_query: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async traceChain<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async traceAgent<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async traceGuardrail<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async traceEmbedding<T>(_model: string, _input: unknown, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async score(_params: { name: string; value: number | string | boolean }): Promise<void> {},
    createSpan(): string {
      return "noop-span";
    },
    endSpan(): void {},
  };
  return createProjectionTee(noop);
}

// Simulate exactly what the Vercel AI SDK's `recordSpan` does:
// tracer.startActiveSpan(name, { attributes }, fn) where fn receives a span,
// sets result attributes via span.setAttributes, then span.end().
async function simulateToolCall(
  tracer: ReturnType<typeof createApoTracer>["tracer"],
  toolName: string,
  toolArgs: Record<string, unknown>,
  toolResult: unknown,
): Promise<void> {
  await tracer.startActiveSpan(
    "ai.toolCall",
    {
      attributes: {
        "ai.toolCall.name": toolName,
        "ai.toolCall.id": `call-${toolName}`,
        "ai.toolCall.args": JSON.stringify(toolArgs),
      },
    },
    async (span) => {
      span.setAttributes({
        "ai.toolCall.result": JSON.stringify(toolResult),
      });
      span.end();
      return undefined;
    },
  );
}

async function simulateGeneration(
  tracer: ReturnType<typeof createApoTracer>["tracer"],
  text: string,
): Promise<void> {
  await tracer.startActiveSpan(
    "ai.generateText",
    {
      attributes: {
        "ai.model.id": "gpt-4o",
      },
    },
    async (span) => {
      span.setAttributes({
        "ai.response.text": text,
      });
      span.end();
      return undefined;
    },
  );
}

describe("createApoTracer", () => {
  it("translates ai.toolCall spans into TOOL observations", async () => {
    const { trace, getSnapshot } = makeTee();
    const { tracer } = createApoTracer({ trace, parentSpanId: "root" });

    await simulateToolCall(tracer, "read_file", { path: "spec.md" }, { content: "hello" });
    await simulateToolCall(tracer, "search_content", { query: "test" }, { matches: [] });

    const snapshot = getSnapshot();
    const toolCalls = snapshot.observations.filter((o) => o.type === "TOOL");

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      type: "TOOL",
      toolName: "read_file",
      toolParameters: { path: "spec.md" },
      output: { content: "hello" },
    });
    expect(toolCalls[1]).toMatchObject({
      type: "TOOL",
      toolName: "search_content",
      toolParameters: { query: "test" },
      output: { matches: [] },
    });
  });

  it("translates ai.generateText spans into GENERATION observations", async () => {
    const { trace, getSnapshot } = makeTee();
    const { tracer } = createApoTracer({ trace, parentSpanId: "root" });

    await simulateGeneration(tracer, "The answer is 42.");

    const snapshot = getSnapshot();
    const generations = snapshot.observations.filter((o) => o.type === "GENERATION");

    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatchObject({
      type: "GENERATION",
      messages: [{ role: "assistant", content: "The answer is 42." }],
    });
  });

  it("makes t.calledTool work end-to-end through the projection-tee", async () => {
    const { trace, getSnapshot } = makeTee();
    const { tracer } = createApoTracer({ trace, parentSpanId: "root" });

    await simulateGeneration(tracer, "Done.");
    await simulateToolCall(tracer, "read_file", { path: "contract.pdf" }, { text: "contents" });
    await simulateToolCall(tracer, "extract_entities", { type: "parties" }, { parties: ["acme"] });

    resetFlowChecks();
    defineCheck("used-read-file", (t) => {
      t.calledTool("read_file", { input: { path: "contract.pdf" } });
    });
    defineCheck("used-extract", (t) => {
      t.calledTool("extract_entities");
      t.noFailedActions();
    });

    const results = await runTraceChecks({ snapshot: getSnapshot(), deliverables: {} });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.pass)).toBe(true);
  });

  it("records error status when the AI SDK reports an error", async () => {
    const { trace, getSnapshot } = makeTee();
    const { tracer } = createApoTracer({ trace, parentSpanId: "root" });

    // Simulate a tool call that errors: the AI SDK calls recordException + setStatus(ERROR) + end.
    await tracer.startActiveSpan(
      "ai.toolCall",
      {
        attributes: {
          "ai.toolCall.name": "failing_tool",
          "ai.toolCall.id": "call-err",
          "ai.toolCall.args": JSON.stringify({}),
        },
      },
      async (span) => {
        span.recordException({ name: "Error", message: "tool failed" });
        span.setStatus({ code: 2, message: "tool failed" });
        span.end();
        return undefined;
      },
    );

    const snapshot = getSnapshot();
    const toolCalls = snapshot.observations.filter((o) => o.type === "TOOL");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ name: "failing_tool", status: "error" });
  });

  it("ignores non-load-bearing spans (ai.generateText.doGenerate etc.)", async () => {
    const { trace, getSnapshot } = makeTee();
    const { tracer } = createApoTracer({ trace, parentSpanId: "root" });

    // The AI SDK emits several spans we don't care about.
    await tracer.startActiveSpan("ai.generateText.doGenerate", { attributes: {} }, async (span) => {
      span.end();
      return undefined;
    });

    const snapshot = getSnapshot();
    expect(snapshot.observations).toHaveLength(0);
  });

  it("passes prompt_tokens/completion_tokens from ai.usage.* to endSpan", async () => {
    // Regression: the GENERATION branch used to drop token usage, so runs
    // showed $0.00 cost. endSpan must receive the token counts so the trace
    // tracker can estimate cost.
    const endSpanCalls: Array<{ spanId: string; params?: Record<string, unknown> }> = [];
    const captureCtx: AgentTaskTraceContext = {
      ...makeTee().trace,
      endSpan(spanId: string, params?: Record<string, unknown>) {
        endSpanCalls.push({ spanId, params });
      },
    };

    const { tracer } = createApoTracer({ trace: captureCtx, parentSpanId: "root" });
    await tracer.startActiveSpan(
      "ai.generateText",
      { attributes: { "ai.model.id": "google/gemini-2.5-flash" } },
      async (span) => {
        span.setAttributes({
          "ai.response.text": "Extracted data.",
          "ai.usage.promptTokens": 1234,
          "ai.usage.completionTokens": 567,
        });
        span.end();
        return undefined;
      },
    );

    expect(endSpanCalls).toHaveLength(1);
    expect(endSpanCalls[0]?.params).toMatchObject({
      prompt_tokens: 1234,
      completion_tokens: 567,
    });
  });

  it("still works when ai.usage.* attributes are absent", async () => {
    const endSpanCalls: Array<{ spanId: string; params?: Record<string, unknown> }> = [];
    const captureCtx: AgentTaskTraceContext = {
      ...makeTee().trace,
      endSpan(spanId: string, params?: Record<string, unknown>) {
        endSpanCalls.push({ spanId, params });
      },
    };

    const { tracer } = createApoTracer({ trace: captureCtx, parentSpanId: "root" });
    await tracer.startActiveSpan(
      "ai.generateText",
      { attributes: { "ai.model.id": "gpt-4o" } },
      async (span) => {
        span.setAttributes({ "ai.response.text": "No usage here." });
        span.end();
        return undefined;
      },
    );

    expect(endSpanCalls).toHaveLength(1);
    // No token keys should be present when usage attrs are absent.
    expect(endSpanCalls[0]?.params).not.toHaveProperty("prompt_tokens");
    expect(endSpanCalls[0]?.params).not.toHaveProperty("completion_tokens");
  });
});
