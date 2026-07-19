import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { trace, context, type Span, SpanStatusCode } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

import { createProjectionTee } from "../../src/agent-task/trace-projection/projection-tee.ts";
import type { AgentTaskTraceContext } from "../../src/agent-task/tracing.ts";
import { ApoSpanProcessor } from "../../src/agent-task/integrations/otel-processor.ts";
import { withApoRun } from "../../src/agent-task/integrations/run-context.ts";
import { defineCheck, resetFlowChecks, runTraceChecks } from "../../src/agent-task/checks/flow-runner.ts";

function makeTee() {
  const noop: AgentTaskTraceContext = {
    runId: "test-run",
    rootSpanId: "root",
    async step<T>(_o: { step_name: string }, fn: (_s: string) => Promise<T>): Promise<T> {
      return fn("s");
    },
    recordEvent: () => "e",
    endRoot: () => {},
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
    async score(_p: { name: string; value: number | string | boolean }): Promise<void> {},
    createSpan: () => "noop",
    endSpan: () => {},
  };
  return createProjectionTee(noop);
}

// Helper: emit a span the way the AI SDK does — attributes at creation (startActiveSpan options),
// result attributes via setAttribute during execution, then end.
async function emitToolCall(
  tracer: ReturnType<typeof trace.getTracer>,
  name: string,
  args: Record<string, unknown>,
  result: unknown,
) {
  await tracer.startActiveSpan(
    "ai.toolCall",
    { attributes: { "ai.toolCall.name": name, "ai.toolCall.args": JSON.stringify(args) } },
    async (span: Span) => {
      span.setAttribute("ai.toolCall.result", JSON.stringify(result));
      span.end();
    },
  );
}

async function emitGeneration(
  tracer: ReturnType<typeof trace.getTracer>,
  model: string,
  text: string,
  promptTokens?: number,
  completionTokens?: number,
) {
  await tracer.startActiveSpan(
    "ai.generateText",
    { attributes: { "ai.model.id": model } },
    async (span: Span) => {
      if (text) span.setAttribute("ai.response.text", text);
      if (promptTokens !== undefined) span.setAttribute("ai.usage.promptTokens", promptTokens);
      if (completionTokens !== undefined) span.setAttribute("ai.usage.completionTokens", completionTokens);
      span.end();
    },
  );
}

describe("ApoSpanProcessor", () => {
  let provider: BasicTracerProvider;
  let processor: ApoSpanProcessor;
  let tracer: ReturnType<typeof trace.getTracer>;

  beforeEach(() => {
    processor = new ApoSpanProcessor();
    provider = new BasicTracerProvider({ spanProcessors: [processor] });
    trace.setGlobalTracerProvider(provider);
    tracer = trace.getTracer("test");
  });

  afterEach(() => {
    processor.reset();
    provider.shutdown();
    context.disable();
  });

  it("translates ai.toolCall spans to TOOL observations", async () => {
    const { trace: apoTrace, getSnapshot } = makeTee();

    await withApoRun({ trace: apoTrace, parentSpanId: "root" }, async () => {
      await emitToolCall(tracer, "read_file", { path: "spec.md" }, { content: "hello" });
      await emitToolCall(tracer, "search_content", { query: "test" }, { matches: [] });
    });

    const toolCalls = getSnapshot().observations.filter((o) => o.type === "TOOL");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({ toolName: "read_file", toolParameters: { path: "spec.md" }, output: { content: "hello" } });
    expect(toolCalls[1]).toMatchObject({ toolName: "search_content", toolParameters: { query: "test" } });
  });

  it("translates ai.generateText spans to GENERATION observations", async () => {
    const { trace: apoTrace, getSnapshot } = makeTee();

    await withApoRun({ trace: apoTrace, parentSpanId: "root" }, async () => {
      await emitGeneration(tracer, "gpt-4o", "The answer is 42.", 100, 50);
    });

    const generations = getSnapshot().observations.filter((o) => o.type === "GENERATION");
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatchObject({ messages: [{ role: "assistant", content: "The answer is 42." }] });
  });

  it("does not translate ai.generateText.doGenerate child spans", async () => {
    const { trace: apoTrace, getSnapshot } = makeTee();

    await withApoRun({ trace: apoTrace, parentSpanId: "root" }, async () => {
      // The per-step doGenerate span should be ignored (housekeeping)
      await tracer.startActiveSpan("ai.generateText.doGenerate", async (span: Span) => {
        span.end();
      });
    });

    expect(getSnapshot().observations).toHaveLength(0);
  });

  it("translates gen_ai.* convention tool spans", async () => {
    const { trace: apoTrace, getSnapshot } = makeTee();

    await withApoRun({ trace: apoTrace, parentSpanId: "root" }, async () => {
      await tracer.startActiveSpan(
        "tool.execute",
        { attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "search", "gen_ai.tool.call.arguments": JSON.stringify({ query: "test" }) } },
        async (span: Span) => {
          span.setAttribute("gen_ai.tool.call.result", JSON.stringify({ matches: [] }));
          span.end();
        },
      );
    });

    const toolCalls = getSnapshot().observations.filter((o) => o.type === "TOOL");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ toolName: "search", toolParameters: { query: "test" } });
  });

  it("ignores non-GenAI spans", async () => {
    const { trace: apoTrace, getSnapshot } = makeTee();

    await withApoRun({ trace: apoTrace, parentSpanId: "root" }, async () => {
      await tracer.startActiveSpan("http.request", async (span: Span) => {
        span.setAttribute("http.method", "POST");
        span.end();
      });
    });

    expect(getSnapshot().observations).toHaveLength(0);
  });

  it("ignores spans fired outside a run", async () => {
    await tracer.startActiveSpan("ai.toolCall", async (span: Span) => {
      span.end();
    });
    expect(processor["spanMap"].size).toBe(0);
  });

  it("records error status on failed spans", async () => {
    const { trace: apoTrace, getSnapshot } = makeTee();

    await withApoRun({ trace: apoTrace, parentSpanId: "root" }, async () => {
      await tracer.startActiveSpan(
        "ai.toolCall",
        { attributes: { "ai.toolCall.name": "failing_tool", "ai.toolCall.args": "{}" } },
        async (span: Span) => {
          span.setStatus({ code: SpanStatusCode.ERROR, message: "tool crashed" });
          span.end();
        },
      );
    });

    const toolCalls = getSnapshot().observations.filter((o) => o.type === "TOOL");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ name: "failing_tool", status: "error" });
  });

  it("makes t.calledTool work end-to-end through the processor", async () => {
    const { trace: apoTrace, getSnapshot } = makeTee();

    await withApoRun({ trace: apoTrace, parentSpanId: "root" }, async () => {
      // Simulate the AI SDK's pattern: generateText parent → toolCall children
      await tracer.startActiveSpan(
        "ai.generateText",
        { attributes: { "ai.model.id": "gpt-4o" } },
        async (genSpan: Span) => {
          await emitToolCall(tracer, "read_file", { path: "contract.pdf" }, { content: "..." });
          genSpan.setAttribute("ai.response.text", "Done.");
          genSpan.end();
        },
      );
    });

    resetFlowChecks();
    defineCheck("used-read-file", (t) => {
      t.calledTool("read_file", { input: { path: "contract.pdf" } });
    });
    defineCheck("no-failures", (t) => {
      t.noFailedActions();
    });

    const results = await runTraceChecks({ snapshot: getSnapshot(), deliverables: {} });
    expect(results.every((r) => r.pass)).toBe(true);
  });

  it("isolates concurrent runs", async () => {
    const teeA = makeTee();
    const teeB = makeTee();

    const run = (tee: ReturnType<typeof makeTee>, toolName: string) =>
      withApoRun({ trace: tee.trace, parentSpanId: "root" }, async () => {
        await emitToolCall(tracer, toolName, {}, {});
      });

    await Promise.all([run(teeA, "tool_a"), run(teeB, "tool_b")]);

    expect(teeA.getSnapshot().observations.filter((o) => o.type === "TOOL")).toHaveLength(1);
    expect(teeB.getSnapshot().observations.filter((o) => o.type === "TOOL")).toHaveLength(1);
    expect(teeA.getSnapshot().observations[0]).toMatchObject({ name: "tool_a" });
    expect(teeB.getSnapshot().observations[0]).toMatchObject({ name: "tool_b" });
  });

  it("passes prompt_tokens/completion_tokens from ai.usage.* to endSpan", async () => {
    // Contract test: the OTel-native path must forward token counts to endSpan
    // so the trace tracker can estimate cost. This guards against the same
    // class of bug that hit the createApoTracer path (tokens dropped).
    const endSpanCalls: Array<{ spanId: string; params?: Record<string, unknown> }> = [];
    const captureTee = makeTee();
    const captureCtx: AgentTaskTraceContext = {
      ...captureTee.trace,
      endSpan(spanId: string, params?: Record<string, unknown>) {
        endSpanCalls.push({ spanId, params });
      },
    };

    await withApoRun({ trace: captureCtx, parentSpanId: "root" }, async () => {
      await emitGeneration(tracer, "gpt-4o", "The answer is 42.", 100, 50);
    });

    expect(endSpanCalls.length).toBeGreaterThanOrEqual(1);
    const genCall = endSpanCalls.find((c) => c.params?.prompt_tokens !== undefined);
    expect(genCall).toBeDefined();
    expect(genCall?.params).toMatchObject({
      prompt_tokens: 100,
      completion_tokens: 50,
    });
  });
});
