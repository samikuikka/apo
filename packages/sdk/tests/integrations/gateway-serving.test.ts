import { describe, it, expect, afterEach } from "vitest";
import { createApoOpenAI } from "../../src/agent-task/integrations/openai.ts";
import {
  servingFromResponse,
  servingHostFromBaseURL,
} from "../../src/agent-task/integrations/span-helpers.ts";
import type { AgentTaskTraceContext } from "../../src/agent-task/tracing.ts";
import type { EndSpanParams } from "../../src/types.ts";

/**
 * Gateway-reported serving hosts: the OpenAI wrapper learns who actually
 * served a call from the response itself — OpenRouter's opt-in routing
 * metadata, LiteLLM's deployment headers — and APO_SERVING_GATEWAY names a
 * private-host gateway the operator controls.
 */

afterEach(() => {
  delete process.env.APO_SERVING_GATEWAY;
});

function fakeHeaders(map: Record<string, string>): { get(name: string): string | null } {
  return {
    get(name: string): string | null {
      return map[name.toLowerCase()] ?? null;
    },
  };
}

describe("servingFromResponse", () => {
  it("reads OpenRouter's selected endpoint as the serving provider", () => {
    const serving = servingFromResponse(
      {
        openrouter_metadata: {
          endpoints: {
            available: [
              { provider: "deepseek" },
              { provider: "fireworks", selected: true },
            ],
          },
        },
      },
      null,
    );
    expect(serving).toEqual({
      provider: "openrouter",
      route: "openrouter:fireworks",
    });
  });

  it("reads LiteLLM's deployment id and upstream from response headers", () => {
    const serving = servingFromResponse(
      {},
      fakeHeaders({
        "x-litellm-model-id": "dep-abc123",
        "x-litellm-model-api-base":
          "https://fireworks-proxy.accounts.fireworks.ai/v1",
      }),
    );
    expect(serving).toEqual({
      provider: "litellm",
      route: "litellm:dep-abc123@fireworks-proxy.accounts.fireworks.ai",
    });
  });

  it("routes without an api-base when LiteLLM omits the upstream header", () => {
    const serving = servingFromResponse(
      {},
      fakeHeaders({ "x-litellm-model-id": "dep-1" }),
    );
    expect(serving).toEqual({ provider: "litellm", route: "litellm:dep-1" });
  });

  it("returns nothing when the gateway reports nothing", () => {
    expect(servingFromResponse({}, null)).toEqual({});
    expect(servingFromResponse({}, fakeHeaders({}))).toEqual({});
  });
});

describe("APO_SERVING_GATEWAY", () => {
  it("names a private-host gateway the operator declared", () => {
    process.env.APO_SERVING_GATEWAY = "litellm";
    expect(servingHostFromBaseURL("http://localhost:4000/v1")).toEqual({
      provider: "litellm",
    });
  });

  it("stays unknown for private hosts without the declaration", () => {
    expect(servingHostFromBaseURL("http://localhost:4000/v1")).toEqual({});
  });
});

/** A trace context that records endSpan params for assertions. */
function recordingContext(): {
  ctx: AgentTaskTraceContext;
  ends: Map<string, EndSpanParams>;
} {
  const ends = new Map<string, EndSpanParams>();
  let n = 0;
  const ctx = {
    runId: "test-run",
    rootSpanId: "root",
    async step<T>(
      _opts: Record<string, unknown>,
      fn: (spanId: string) => Promise<T>,
    ): Promise<T> {
      return fn("step-span");
    },
    recordEvent(): string {
      return "event-span";
    },
    endRoot(): void {},
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
    async score(): Promise<void> {},
    createSpan(): string {
      n += 1;
      return `span-${n}`;
    },
    endSpan(_spanId: string, params: EndSpanParams): void {
      ends.set(_spanId, params);
    },
  } as unknown as AgentTaskTraceContext;
  return { ctx, ends };
}

describe("createApoOpenAI wrapper learns serving from the response", () => {
  it("emits OpenRouter's selected provider as end-time serving attributes", async () => {
    const { ctx, ends } = recordingContext();
    const body = {
      model: "deepseek/deepseek-v4.1-flash",
      choices: [{ message: { content: "hello" } }],
      openrouter_metadata: {
        endpoints: { available: [{ provider: "fireworks", selected: true }] },
      },
    };
    const client = createApoOpenAI(
      {
        baseURL: "https://openrouter.ai/api/v1",
        chat: {
          completions: {
            withRawResponse: {
              async create() {
                return {
                  headers: fakeHeaders({}),
                  async parse() {
                    return body;
                  },
                };
              },
            },
            async create() {
              return body;
            },
          },
        },
      } as never,
      { trace: ctx },
    );
    const response = await client.chat.completions.create({
      model: "deepseek/deepseek-v4.1-flash",
      messages: [],
    });
    expect(response).toBe(body);
    const end = [...ends.values()].find((p) => p.served_model) as EndSpanParams;
    expect(end.served_model).toBe("deepseek/deepseek-v4.1-flash");
    expect(end.provider).toBe("openrouter");
    expect(end.route).toBe("openrouter:fireworks");
  });

  it("emits LiteLLM's deployment from response headers", async () => {
    const { ctx, ends } = recordingContext();
    const body = {
      model: "anthropic/claude-sonnet-4-6",
      choices: [{ message: { content: "hi" } }],
    };
    const client = createApoOpenAI(
      {
        baseURL: "http://localhost:4000/v1",
        chat: {
          completions: {
            withRawResponse: {
              async create() {
                return {
                  headers: fakeHeaders({
                    "x-litellm-model-id": "dep-42",
                    "x-litellm-model-api-base":
                      "https://api.anthropic.com/v1",
                  }),
                  async parse() {
                    return body;
                  },
                };
              },
            },
            async create() {
              return body;
            },
          },
        },
      } as never,
      { trace: ctx },
    );
    await client.chat.completions.create({
      model: "ssg/claude-sonnet",
      messages: [],
    });
    const end = [...ends.values()].find((p) => p.served_model) as EndSpanParams;
    expect(end.served_model).toBe("anthropic/claude-sonnet-4-6");
    expect(end.provider).toBe("litellm");
    expect(end.route).toBe("litellm:dep-42@api.anthropic.com");
  });

  it("falls back to the plain call when withRawResponse is absent", async () => {
    const { ctx, ends } = recordingContext();
    const body = {
      model: "gpt-5.6",
      choices: [{ message: { content: "plain" } }],
    };
    const client = createApoOpenAI(
      {
        baseURL: "https://api.openai.com/v1",
        chat: {
          completions: {
            async create() {
              return body;
            },
          },
        },
      } as never,
      { trace: ctx },
    );
    await client.chat.completions.create({ model: "gpt-5.6", messages: [] });
    const end = [...ends.values()].find((p) => p.served_model) as EndSpanParams;
    expect(end.served_model).toBe("gpt-5.6");
    expect(end.provider).toBeUndefined();
    expect(end.route).toBeUndefined();
  });
});
