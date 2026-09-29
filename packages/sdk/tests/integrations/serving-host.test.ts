import { describe, it, expect } from "vitest";
import type { AgentTaskTraceContext } from "../../src/agent-task/tracing.ts";
import {
  servingHostFromBaseURL,
  startGeneration,
} from "../../src/agent-task/integrations/span-helpers.ts";
import { createApoOpenAI } from "../../src/agent-task/integrations/openai.ts";
import { createApoAnthropic } from "../../src/agent-task/integrations/anthropic.ts";

describe("servingHostFromBaseURL (issue #307)", () => {
  it("defaults to the vendor when no baseURL is set", () => {
    expect(servingHostFromBaseURL(undefined, "openai")).toEqual({ provider: "openai" });
    expect(servingHostFromBaseURL("", "anthropic")).toEqual({ provider: "anthropic" });
  });

  it("returns nothing without a baseURL and no vendor default", () => {
    expect(servingHostFromBaseURL(undefined)).toEqual({});
  });

  it("maps known gateway hosts to their provider name", () => {
    expect(servingHostFromBaseURL("https://openrouter.ai/api/v1")).toEqual({
      provider: "openrouter",
    });
    expect(servingHostFromBaseURL("https://api.anthropic.com")).toEqual({
      provider: "anthropic",
    });
    // The OpenAI SDK pointed at another vendor still reports that vendor,
    // not the SDK it was built with.
    expect(servingHostFromBaseURL("https://api.groq.com/v1", "openai")).toEqual({
      provider: "groq",
    });
  });

  it("reports a custom gateway as provider domain + full-host route", () => {
    expect(servingHostFromBaseURL("https://gw.internal.example.com/v1")).toEqual({
      provider: "example.com",
      route: "gw.internal.example.com",
    });
  });

  it("reports nothing for local proxies — the real host behind them is unknown", () => {
    expect(servingHostFromBaseURL("http://localhost:11434/v1", "openai")).toEqual({});
    expect(servingHostFromBaseURL("http://127.0.0.1:8080", "openai")).toEqual({});
    expect(servingHostFromBaseURL("http://192.168.1.5:9000", "openai")).toEqual({});
  });

  it("tolerates junk without throwing", () => {
    expect(servingHostFromBaseURL("not a url", "openai")).toEqual({ provider: "openai" });
    expect(servingHostFromBaseURL(42, "openai")).toEqual({ provider: "openai" });
  });
});

/** A trace context whose createSpan records what it was asked to emit. */
function recordingTrace(): {
  trace: AgentTaskTraceContext;
  spans: Array<Record<string, unknown>>;
} {
  const spans: Array<Record<string, unknown>> = [];
  const trace = {
    runId: "test-run",
    rootSpanId: "root",
    async step<T>(
      _opts: { step_name: string },
      fn: (_spanId: string) => Promise<T>,
    ): Promise<T> {
      return fn("step-span");
    },
    recordEvent(): string {
      return "event-span";
    },
    endRoot(): void {},
    async traceTool<T>(
      _name: string,
      _params: Record<string, unknown>,
      fn: () => Promise<T>,
    ): Promise<T> {
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
    async score(): Promise<void> {},
    createSpan(params: Record<string, unknown>): string {
      spans.push(params);
      return `span-${spans.length}`;
    },
    endSpan(): void {},
  } as unknown as AgentTaskTraceContext;
  return { trace, spans };
}

describe("startGeneration carries the serving host", () => {
  it("passes provider and route into the span params", () => {
    const { trace, spans } = recordingTrace();
    startGeneration(trace, {
      model: "deepseek-v4.1-flash",
      provider: "fireworks",
      route: "priority",
    });
    expect(spans[0]?.provider).toBe("fireworks");
    expect(spans[0]?.route).toBe("priority");
  });
});

function fakeClient(baseURL: string | undefined, kind: "openai" | "anthropic") {
  if (kind === "openai") {
    return {
      baseURL,
      chat: {
        completions: {
          async create(params: Record<string, unknown>) {
            return {
              model: params.model,
              choices: [
                { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          },
        },
      },
    };
  }
  return {
    baseURL,
    messages: {
      async create(params: Record<string, unknown>) {
        return {
          model: params.model,
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    },
  };
}

describe("vendor wrappers label the serving host", () => {
  it("openai wrapper resolves an OpenRouter endpoint", async () => {
    const { trace, spans } = recordingTrace();
    const client = createApoOpenAI(
      fakeClient("https://openrouter.ai/api/v1", "openai") as never,
      { trace },
    );
    await client.chat.completions.create({ model: "deepseek-v4.1-flash", messages: [] });
    const generation = spans.find((s) => s.observation_type === "GENERATION");
    expect(generation?.provider).toBe("openrouter");
  });

  it("openai wrapper defaults to openai without a baseURL", async () => {
    const { trace, spans } = recordingTrace();
    const client = createApoOpenAI(fakeClient(undefined, "openai") as never, { trace });
    await client.chat.completions.create({ model: "gpt-5.6-terra", messages: [] });
    const generation = spans.find((s) => s.observation_type === "GENERATION");
    expect(generation?.provider).toBe("openai");
  });

  it("anthropic wrapper reports a custom gateway as domain + route", async () => {
    const { trace, spans } = recordingTrace();
    const client = createApoAnthropic(
      fakeClient("https://llm-gw.corp.example.org/v1", "anthropic") as never,
      { trace },
    );
    await client.messages.create({ model: "claude-opus-5", messages: [] });
    const generation = spans.find((s) => s.observation_type === "GENERATION");
    expect(generation?.provider).toBe("example.org");
    expect(generation?.route).toBe("llm-gw.corp.example.org");
  });
});
