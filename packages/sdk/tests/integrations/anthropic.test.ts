import { describe, it, expect } from "vitest";
import { createProjectionTee } from "../../src/agent-task/trace-projection/projection-tee.ts";
import type { AgentTaskTraceContext } from "../../src/agent-task/tracing.ts";
import { createApoAnthropic } from "../../src/agent-task/integrations/anthropic.ts";
import { defineCheck, resetFlowChecks, runTraceChecks } from "../../src/agent-task/checks/flow-runner.ts";

// Same noop-trace + projection-tee fixture.
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

// A fake Anthropic client whose `messages.create` returns content blocks
// with tool_use — the same shape the real SDK returns.
function makeFakeAnthropicClient(toolUses: Array<{ name: string; input?: unknown }>) {
  return {
    messages: {
      async create(params: Record<string, unknown>) {
        const content: Array<{ type: string; text?: string; name?: string; input?: unknown }> = [];
        if (toolUses.length === 0) {
          content.push({ type: "text", text: "The answer is 42." });
        } else {
          content.push({ type: "text", text: "I'll use tools." });
          for (const tu of toolUses) {
            content.push({ type: "tool_use", name: tu.name, input: tu.input ?? {} });
          }
        }
        return {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: params.model,
          stop_reason: toolUses.length > 0 ? "tool_use" : "end_turn",
          content,
          usage: { input_tokens: 80, output_tokens: 40 },
        };
      },
    },
  };
}

describe("createApoAnthropic", () => {
  it("traces tool calls from messages.create responses", async () => {
    const { trace, getSnapshot } = makeTee();
    const fakeClient = makeFakeAnthropicClient([
      { name: "read_file", input: { path: "spec.md" } },
      { name: "search_content", input: { query: "test" } },
    ]);

    const wrapped = createApoAnthropic(fakeClient, { trace, parentSpanId: "root" });
    await wrapped.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
    });

    const snapshot = getSnapshot();
    const toolCalls = snapshot.observations.filter((o) => o.type === "TOOL");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({ toolName: "read_file", toolParameters: { path: "spec.md" } });
    expect(toolCalls[1]).toMatchObject({ toolName: "search_content", toolParameters: { query: "test" } });
  });

  it("traces the generation text for text-only responses", async () => {
    const { trace, getSnapshot } = makeTee();
    const fakeClient = makeFakeAnthropicClient([]);

    const wrapped = createApoAnthropic(fakeClient, { trace, parentSpanId: "root" });
    await wrapped.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
    });

    const snapshot = getSnapshot();
    const generations = snapshot.observations.filter((o) => o.type === "GENERATION");
    expect(generations).toHaveLength(1);
    expect(generations[0]).toMatchObject({ messages: [{ role: "assistant", content: "The answer is 42." }] });
  });

  it("makes t.calledTool work end-to-end", async () => {
    const { trace, getSnapshot } = makeTee();
    const fakeClient = makeFakeAnthropicClient([
      { name: "read_file", input: { path: "contract.pdf" } },
    ]);

    const wrapped = createApoAnthropic(fakeClient, { trace, parentSpanId: "root" });
    await wrapped.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [],
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

  it("returns the original response unchanged", async () => {
    const { trace } = makeTee();
    const fakeClient = makeFakeAnthropicClient([]);

    const wrapped = createApoAnthropic(fakeClient, { trace, parentSpanId: "root" });
    const response = await wrapped.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [],
    });

    expect(response).toMatchObject({ id: "msg_test", type: "message", role: "assistant" });
  });
});
