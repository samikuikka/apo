import { describe, it, expect } from "vitest";
import { createProjectionTee } from "../../src/agent-task/trace-projection/projection-tee.ts";
import type { AgentTaskTraceContext } from "../../src/agent-task/tracing.ts";
import { createApoOpenAI } from "../../src/agent-task/integrations/openai.ts";
import { defineCheck, resetFlowChecks, runTraceChecks } from "../../src/agent-task/checks/flow-runner.ts";

// Same noop-trace + projection-tee fixture as the AI SDK test. The tee wraps
// a no-op trace context and records the span lifecycle into a
// TraceProjectionSnapshot (the FlowTee replacement).
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

// A fake OpenAI client whose `chat.completions.create` returns a canned response
// with tool calls — the same shape the real SDK returns.
function makeFakeOpenAIClient(toolCalls: Array<{ name: string; args: Record<string, unknown>; result?: unknown }>) {
  return {
    chat: {
      completions: {
        async create(params: Record<string, unknown>) {
          return {
            id: "chatcmpl-test",
            object: "chat.completion",
            model: params.model,
            choices: [
              {
                index: 0,
                finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
                message: {
                  role: "assistant",
                  content: toolCalls.length > 0 ? null : "The answer is 42.",
                  tool_calls: toolCalls.map((tc, i) => ({
                    id: `call_${i}`,
                    type: "function",
                    function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                  })),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          };
        },
      },
    },
  };
}

describe("createApoOpenAI", () => {
  it("traces tool calls from chat.completions.create responses", async () => {
    const { trace, getSnapshot } = makeTee();
    const fakeClient = makeFakeOpenAIClient([
      { name: "read_file", args: { path: "spec.md" } },
      { name: "search_content", args: { query: "test" } },
    ]);

    const wrapped = createApoOpenAI(fakeClient, { trace, parentSpanId: "root" });
    await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    });

    const snapshot = getSnapshot();
    const toolCalls = snapshot.observations.filter((o) => o.type === "TOOL");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({ toolName: "read_file", toolParameters: { path: "spec.md" } });
    expect(toolCalls[1]).toMatchObject({ toolName: "search_content", toolParameters: { query: "test" } });
  });

  it("traces the generation text for non-tool responses", async () => {
    const { trace, getSnapshot } = makeTee();
    const fakeClient = makeFakeOpenAIClient([]);

    const wrapped = createApoOpenAI(fakeClient, { trace, parentSpanId: "root" });
    await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
    });

    const snapshot = getSnapshot();
    const generations = snapshot.observations.filter((o) => o.type === "GENERATION");
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatchObject({ messages: [{ role: "assistant", content: "The answer is 42." }] });
  });

  it("makes t.calledTool work end-to-end", async () => {
    const { trace, getSnapshot } = makeTee();
    const fakeClient = makeFakeOpenAIClient([
      { name: "read_file", args: { path: "contract.pdf" } },
      { name: "extract_entities", args: { type: "parties" } },
    ]);

    const wrapped = createApoOpenAI(fakeClient, { trace, parentSpanId: "root" });
    await wrapped.chat.completions.create({ model: "gpt-4o", messages: [] });

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

  it("returns the original response unchanged", async () => {
    const { trace } = makeTee();
    const fakeClient = makeFakeOpenAIClient([]);

    const wrapped = createApoOpenAI(fakeClient, { trace, parentSpanId: "root" });
    const response = await wrapped.chat.completions.create({ model: "gpt-4o", messages: [] });

    expect(response).toMatchObject({ id: "chatcmpl-test", object: "chat.completion" });
  });

  it("passes streaming calls through untraced", async () => {
    const { trace, getSnapshot } = makeTee();
    let realCalled = false;
    const fakeClient = {
      chat: {
        completions: {
          async create(params: Record<string, unknown>) {
            realCalled = true;
            expect(params.stream).toBe(true);
            return { stream: true };
          },
        },
      },
    };

    const wrapped = createApoOpenAI(fakeClient, { trace, parentSpanId: "root" });
    const result = await wrapped.chat.completions.create({ model: "gpt-4o", messages: [], stream: true });

    expect(realCalled).toBe(true);
    expect(result).toEqual({ stream: true });
    expect(getSnapshot().observations).toHaveLength(0);
  });
});
