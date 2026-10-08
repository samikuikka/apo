/**
 * Anthropic-direct judge wire. When the endpoint host or the model id says
 * Anthropic, `t.judge`'s fetch path speaks the Messages API (`/v1/messages`)
 * instead of OpenAI chat-completions:
 *
 * - wire resolution: explicit `provider` > Anthropic host > bare `claude-*`
 *   model id > the OpenAI-compatible default;
 * - auth: `ANTHROPIC_API_KEY` → `x-api-key`, `ANTHROPIC_AUTH_TOKEN` →
 *   `Authorization: Bearer` (the plan-credit credential style);
 * - request shape: system prompt as a top-level param with an Anthropic-native
 *   cache breakpoint, no `response_format`, no `prompt_cache_key`;
 * - response normalization: content blocks, Anthropic usage fields, and a
 *   `max_tokens` stop mapped onto the truncation check's vocabulary.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  anthropicAuth,
  callJudge,
  defaultJudgeAPIKey,
  defaultJudgeBaseURL,
  resolveJudgeWire,
} from "../src/agent-task/checks/judge.ts";
import { loadTaskRuntime } from "../src/agent-task/task-runtime.ts";

// The dev environment loads a real .env into the vitest process (Vite loads
// `<pkg>/.env`), so provider vars from the machine leak into process.env.
// These tests assert env-driven resolution, so they run against a scrubbed
// environment and restore whatever was there on exit.
const PROVIDER_ENV_VARS = [
  "OPENROUTER_MODEL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENAI_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;
const savedEnv: Partial<Record<(typeof PROVIDER_ENV_VARS)[number], string>> = {};
beforeAll(() => {
  for (const name of PROVIDER_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined) {
      savedEnv[name] = value;
      delete process.env[name];
    }
  }
});
afterAll(() => {
  for (const name of PROVIDER_ENV_VARS) {
    if (savedEnv[name] !== undefined) process.env[name] = savedEnv[name];
    else delete process.env[name];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** A well-formed Messages response carrying a verdict in its text blocks. */
function anthropicResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test-1",
    content: [{ type: "text", text: '{"reasoning":"meets the rubric","pass":true}' }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 4 },
    ...overrides,
  };
}

describe("resolveJudgeWire", () => {
  it("explicit provider wins over every other signal", () => {
    expect(
      resolveJudgeWire({ baseURL: "https://gw.internal/v1", model: "some/model", provider: "anthropic" }),
    ).toBe("anthropic");
  });

  it("an Anthropic host selects the anthropic wire", () => {
    expect(resolveJudgeWire({ baseURL: "https://api.anthropic.com", model: "any-model" })).toBe("anthropic");
  });

  it("a bare claude-* model id selects the anthropic wire (no endpoint configured)", () => {
    expect(resolveJudgeWire({ model: "claude-sonnet-4-5" })).toBe("anthropic");
  });

  it("an OpenRouter-qualified anthropic id stays on the OpenAI-compatible wire", () => {
    expect(resolveJudgeWire({ model: "anthropic/claude-sonnet-4.5" })).toBe("openai-compatible");
  });

  it("everything else defaults to the OpenAI-compatible wire", () => {
    expect(resolveJudgeWire({ baseURL: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-v4.1-flash" })).toBe(
      "openai-compatible",
    );
  });
});

describe("anthropicAuth", () => {
  it("an explicit config key is an API key (x-api-key)", () => {
    expect(anthropicAuth("sk-ant-config")).toEqual({ apiKey: "sk-ant-config", asBearer: false });
  });

  it("ANTHROPIC_API_KEY beats ANTHROPIC_AUTH_TOKEN", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "tok");
    expect(anthropicAuth()).toEqual({ apiKey: "sk-ant-api", asBearer: false });
  });

  it("ANTHROPIC_AUTH_TOKEN alone authenticates as a bearer", () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "tok");
    expect(anthropicAuth()).toEqual({ apiKey: "tok", asBearer: true });
  });

  it("nothing set: no credential", () => {
    expect(anthropicAuth()).toEqual({ apiKey: undefined, asBearer: false });
  });
});

describe("wire-aware endpoint defaults", () => {
  it("anthropic wire: Anthropic host, ANTHROPIC_BASE_URL override, key from env", () => {
    expect(defaultJudgeBaseURL(undefined, "anthropic")).toBe("https://api.anthropic.com");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://gw.internal/anthropic");
    expect(defaultJudgeBaseURL(undefined, "anthropic")).toBe("https://gw.internal/anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api");
    expect(defaultJudgeAPIKey(undefined, "anthropic")).toBe("sk-ant-api");
  });

  it("openai-compatible wire: unchanged OpenRouter defaults", () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://gw.internal/anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api");
    expect(defaultJudgeBaseURL(undefined)).toBe("https://openrouter.ai/api/v1");
    expect(defaultJudgeAPIKey(undefined)).toBeUndefined();
  });
});

describe("resolveJudgeFromEnv precedence (loadTaskRuntime)", () => {
  it("ANTHROPIC_MODEL alone configures the anthropic judge", async () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-4-5");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api");
    const runtime = await loadTaskRuntime("/tmp");
    expect(runtime.judge).toMatchObject({
      model: "claude-sonnet-4-5",
      baseURL: "https://api.anthropic.com",
      apiKey: "sk-ant-api",
      provider: "anthropic",
    });
  });

  it("ANTHROPIC_AUTH_TOKEN serves as the anthropic key fallback", async () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-4-5");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "tok");
    const runtime = await loadTaskRuntime("/tmp");
    expect(runtime.judge).toMatchObject({ apiKey: "tok", provider: "anthropic" });
  });

  it("OPENROUTER_MODEL still wins when both are set", async () => {
    vi.stubEnv("OPENROUTER_MODEL", "deepseek/deepseek-v4.1-flash");
    vi.stubEnv("OPENAI_MODEL", "gpt-5-nano");
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-4-5");
    const runtime = await loadTaskRuntime("/tmp");
    expect(runtime.judge).toMatchObject({ model: "deepseek/deepseek-v4.1-flash" });
    expect(runtime.judge?.provider).toBeUndefined();
  });

  it("OPENAI_MODEL beats ANTHROPIC_MODEL", async () => {
    vi.stubEnv("OPENAI_MODEL", "gpt-5-nano");
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-4-5");
    const runtime = await loadTaskRuntime("/tmp");
    expect(runtime.judge).toMatchObject({ model: "gpt-5-nano" });
    expect(runtime.judge?.provider).toBeUndefined();
  });

  it("no model env: no judge", async () => {
    const runtime = await loadTaskRuntime("/tmp");
    expect(runtime.judge).toBeUndefined();
  });
});

describe("callJudge — anthropic wire", () => {
  it("sends a Messages request: system param, cache breakpoint, no OpenAI-only fields", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api");
    const fetchMock = vi.fn(async () => Response.json(anthropicResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callJudge({
      values: ["the deliverable"],
      instruction: "PASS when correct",
      // Bare claude-* id, no baseURL: the model-id backstop selects the wire.
      model: "claude-sonnet-4-5",
    });

    expect(result.pass).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");

    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-api");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.Authorization).toBeUndefined();

    const body = JSON.parse(init.body as string) as Record<string, any>;
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.max_tokens).toBe(8192);
    expect(body.temperature).toBe(0);
    // The deliverable rides the system prompt as a cacheable block —
    // Anthropic-native caching, not the OpenRouter passthrough.
    expect(Array.isArray(body.system)).toBe(true);
    const systemBlocks = body.system as Array<Record<string, any>>;
    expect(systemBlocks[systemBlocks.length - 1].cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(systemBlocks)).toContain("the deliverable");
    // One user turn: the instruction.
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toContain("PASS when correct");
    // Fields the Messages API does not know must not be sent.
    expect(body.response_format).toBeUndefined();
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.stream).toBeUndefined();
  });

  it("ANTHROPIC_AUTH_TOKEN authenticates as a bearer token", async () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "plan-credit-token");
    const fetchMock = vi.fn(async () => Response.json(anthropicResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await callJudge({ values: ["v"], instruction: "i", model: "claude-sonnet-4-5" });

    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer plan-credit-token");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("normalizes Anthropic usage into the shared token fields", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          anthropicResponse({
            usage: {
              input_tokens: 1000,
              output_tokens: 40,
              cache_creation_input_tokens: 900,
              cache_read_input_tokens: 100,
            },
          }),
        ),
      ),
    );

    const result = await callJudge({ values: ["v"], instruction: "i", model: "claude-sonnet-4-5" });

    expect(result.judge.tokens).toMatchObject({
      input: 1000,
      output: 40,
      cache_creation: 900,
      cache_read: 100,
    });
  });

  it("a max_tokens stop maps onto the truncation vocabulary and is retried", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api");
    const truncated = anthropicResponse({
      content: [{ type: "text", text: '{"reasoning":"cut off mid-sent' }],
      stop_reason: "max_tokens",
    });
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return Response.json(call === 1 ? truncated : anthropicResponse());
      }),
    );

    const result = await callJudge({ values: ["v"], instruction: "i", model: "claude-sonnet-4-5" });

    // The truncated draw was retried; the complete verdict stands.
    expect(call).toBe(2);
    expect(result.pass).toBe(true);
    expect(result.unavailable).toBeUndefined();
  });

  it("retries a 429 once and honors Retry-After", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api");
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return call === 1
          ? new Response("rate_limited", { status: 429, headers: { "retry-after": "0" } })
          : Response.json(anthropicResponse());
      }),
    );

    const result = await callJudge({ values: ["v"], instruction: "i", model: "claude-sonnet-4-5" });
    expect(call).toBe(2);
    expect(result.pass).toBe(true);
  });

  it("an Anthropic host on the baseURL selects the wire even for a non-claude model id", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api");
    const fetchMock = vi.fn(async () => Response.json(anthropicResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await callJudge({
      values: ["v"],
      instruction: "i",
      model: "custom-tuned-judge",
      baseURL: "https://api.anthropic.com",
    });

    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toBe("https://api.anthropic.com/v1/messages");
  });

  it("provider override forces the wire behind a non-Anthropic gateway host", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api");
    const fetchMock = vi.fn(async () => Response.json(anthropicResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await callJudge({
      values: ["v"],
      instruction: "i",
      model: "custom-tuned-judge",
      baseURL: "https://gw.internal/anthropic",
      provider: "anthropic",
    });

    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toBe(
      "https://gw.internal/anthropic/v1/messages",
    );
  });
});
