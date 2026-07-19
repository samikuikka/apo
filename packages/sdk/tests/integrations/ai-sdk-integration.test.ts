import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runTask } from "../../src/agent-task/run/runTask.ts";

const TMP_ROOT = join(import.meta.dirname, ".tmp-ai-sdk-integration");

function setupTaskDir(files: Record<string, string>): string {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
  const taskDir = join(TMP_ROOT, "demo-task");
  mkdirSync(taskDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(taskDir, relativePath);
    mkdirSync(join(absolutePath, ".."), { recursive: true });
    writeFileSync(absolutePath, content);
  }
  return taskDir;
}

function teardown(): void {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
}

// Build an adapter that uses createApoTracer + a mocked generateText.
// The mocked generateText calls the tracer the same way the real AI SDK does:
// startActiveSpan("ai.generateText"), then startActiveSpan("ai.toolCall") per tool.
const ADAPTER_SOURCE = `
import { z } from "zod";
import { defineAdapter, createApoTracer } from "@apo/sdk/agent-task";

// Mocked generateText: simulates what the Vercel AI SDK does when telemetry is enabled.
// It calls the tracer's startActiveSpan with the same span names and attributes.
async function mockGenerateText({ experimental_telemetry, tools }: {
  experimental_telemetry?: { isEnabled: boolean; tracer: any };
  tools: Record<string, { result: unknown }>;
}) {
  const tracer = experimental_telemetry?.isEnabled ? experimental_telemetry.tracer : null;
  if (!tracer) {
    return { text: "no tracing", toolCalls: [] };
  }

  // Simulate ai.generateText span
  return tracer.startActiveSpan("ai.generateText", { attributes: { "ai.model.id": "mock-model" } }, async (genSpan: any) => {
    const toolCalls: Array<{ toolName: string; input: any }> = [];

    for (const [name, def] of Object.entries(tools)) {
      const input = { path: "spec.md" };
      // Simulate ai.toolCall span (the AI SDK emits these)
      await tracer.startActiveSpan("ai.toolCall", {
        attributes: {
          "ai.toolCall.name": name,
          "ai.toolCall.id": "call-" + name,
          "ai.toolCall.args": JSON.stringify(input),
        },
      }, async (toolSpan: any) => {
        toolSpan.setAttributes({
          "ai.toolCall.result": JSON.stringify(def.result),
        });
        toolSpan.end();
        toolCalls.push({ toolName: name, input });
      });
    }

    genSpan.setAttributes({ "ai.response.text": "Analysis complete." });
    genSpan.end();
    return { text: "Analysis complete.", toolCalls };
  });
}

export const mockAdapter = defineAdapter({
  name: "mock-ai-sdk",
  deliverables: {
    result: z.object({ text: z.string() }),
  },
  turn: async ({ transcript }) => {
    if (transcript.length > 0) return null;
    return "analyze the spec";
  },
  async startSession(ctx) {
    return {
      async sendUserTurn(turn: unknown, context: any) {
        const result = await mockGenerateText({
          experimental_telemetry: createApoTracer({
            trace: context.trace,
            parentSpanId: context.parentSpanId,
            taskId: ctx.task.id,
            turnNumber: context.turnNumber,
          }),
          tools: {
            read_file: { result: { content: "file contents here" } },
            search_content: { result: { matches: ["line 1", "line 2"] } },
          },
        });
        return { response: result.text };
      },
    };
  },
  async collectDeliverables() {
    return { result: { text: "Analysis complete." } };
  },
});
`;

const TASK_SOURCE = `
import { task, test } from "@apo/sdk/agent-task";
import { mockAdapter } from "./adapter.ts";

task("demo-task", {
  adapter: mockAdapter,
  deliverables: ["result"],
});

test("called-read-file", (t) => {
  t.calledTool("read_file", { input: { path: "spec.md" } });
});

test("called-search", (t) => {
  t.calledTool("search_content");
});

test("no-failures", (t) => {
  t.noFailedActions();
});

test("used-two-tools", (t) => {
  t.maxToolCalls(2);
});
`;

describe("createApoTracer integration with runTask", () => {
  let taskDir: string;

  beforeEach(() => {
    taskDir = setupTaskDir({
      "demo-task.eval.ts": TASK_SOURCE,
      "adapter.ts": ADAPTER_SOURCE,
    });
  });

  afterEach(teardown);

  it("traces tool calls through the FlowTee so t.calledTool works", async () => {
    // runTask with no tracing option → noop trace, but FlowTee still captures spans.
    const result = await runTask(taskDir);

    expect(result).toBeDefined();
    expect(result.result.pass).toBe(true);

    // Every test should pass — the tracer fed tool_call events into the Flow.
    const checkResults = result.result.checks ?? [];
    expect(checkResults).toHaveLength(4);
    for (const check of checkResults) {
      expect(check.pass).toBe(true);
    }
  }, 15000);
});
