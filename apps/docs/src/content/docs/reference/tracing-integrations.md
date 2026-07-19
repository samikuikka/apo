---
title: Tracing integrations
description: "Tracing for popular LLM SDKs — the Vercel AI SDK with native OTel, the registerApoTracing path for any OTel-emitting SDK, and manual wrappers as a fallback."
---

For `t.calledTool`, `t.noFailedActions`, and `t.messageIncludes` to read anything, your adapter's `sendUserTurn` must record what the agent *did*. How you do that depends on your SDK:

| Strategy | Use it when |
|---|---|
| **Vercel AI SDK** (`generateText` + `experimental_telemetry`) | **Recommended.** You use the `ai` package with `@ai-sdk/openai` or `@ai-sdk/anthropic`. The SDK emits `gen_ai.*` OTel spans natively — zero span code in your adapter. |
| **OTel-native** (`registerApoTracing`) | Your SDK emits OpenTelemetry GenAI spans on its own (OpenAI Agents SDK, Claude Agent SDK, LangChain with OTel enabled). One registration covers any such SDK. |
| **Manual wrappers** (`createApoOpenAI`, `createApoAnthropic`) | Fallback for custom clients or SDKs that don't emit OTel (the raw `openai` / `@anthropic-ai/sdk` packages). |

## Vercel AI SDK (`generateText`, `streamText`) — recommended

The simplest path. The Vercel AI SDK emits standard `gen_ai.*` OpenTelemetry spans when you enable telemetry — model name, token usage, tool calls, messages, everything. Your adapter has **zero span code**: one flag on the call, one `registerApoTracing()` at startup.

```typescript
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { registerApoTracing } from "@apo/sdk/agent-task";

// Register once at module load — idempotent.
await registerApoTracing();

const client = createOpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" });

async sendUserTurn(turn, { trace, parentSpanId }) {
  const result = await generateText({
    model: client.chat("google/gemini-2.5-flash-lite"),
    system: SYSTEM_PROMPT,
    messages,
    tools,
    experimental_telemetry: { isEnabled: true }, // ← that's it
  });
  return { response: result.text };
}
```

What happens automatically:

- `ai.generateText.doGenerate` spans become GENERATION observations with model + token usage → cost is computed
- `ai.toolCall` spans become TOOL observations → `t.calledTool(name)` works
- Errors become failed actions → `t.noFailedActions()` catches them

:::note[Transparent lifecycle wrappers]
The `ai.generateText` and `ai.streamText` lifecycle wrappers are **transparent** in the projection: they stay in canonical telemetry for debugging, but produce no observation in the trace projection. Their children (`doGenerate` / `doStream`) reparent to the nearest retained ancestor. This prevents double-counting usage and cost across wrapper + child, and keeps `toolOrder` / `calledTool` assertions reading the effective graph — not a flat list with synthetic container rows.
:::

For Anthropic, swap the provider: import `createAnthropic` from `@ai-sdk/anthropic` instead of `createOpenAI`, and everything else stays identical. For a complete adapter example, see [`ai-sdk-adapter.ts`](https://github.com/samikuikka/apo/blob/main/apps/example-service/e2e/agent-task-demo/ai-sdk-adapter.ts) in the example service, or [`real-agent-adapter.ts`](https://github.com/samikuikka/apo/blob/main/apps/example-service/e2e/agent-task-demo/real-agent-adapter.ts) for the full multi-turn pattern.

:::note[How it works]
`registerApoTracing()` creates apo's `ApoSpanProcessor` but does **not** attach it to a provider itself. The task runner's trace client picks the registered processor up when it builds the OTel provider (via `configureApoTelemetry`), which feeds GenAI spans to **both** the local projection (so your `t.*` assertions see them) **and** the OTLP exporter (so they reach the backend). When the Vercel AI SDK emits spans (`experimental_telemetry` enabled), the processor translates them into apo observations and routes them to the correct run via `AsyncLocalStorage`. The SDK owns the span lifecycle — apo just receives the data.
:::

## OTel-native (`registerApoTracing`)

The same `registerApoTracing()` call works for **any** SDK that emits OpenTelemetry GenAI spans — the OpenAI Agents SDK, Claude Agent SDK, LangChain with OTel enabled, etc. You don't need a per-SDK wrapper.

```typescript
import { registerApoTracing, withApoRun } from "@apo/sdk/agent-task";

await registerApoTracing(); // one line, once

async sendUserTurn(turn, { trace, parentSpanId }) {
  // Wrap your agent call in withApoRun so the SpanProcessor knows
  // which run a span belongs to.
  return withApoRun(
    { trace, parentSpanId },
    () => runMyOtelEmittingAgent(String(turn)),
  );
}
```

```typescript
async function registerApoTracing(options?: RegisterApoTracingOptions): Promise<void>;

interface RegisterApoTracingOptions {
  setGlobal?: boolean; // default true
}
```

Registration is idempotent — calling it more than once is a no-op.

:::note[This recipe is for adapter authors]
The example assumes you're inside a task-run adapter — the task runner builds the OTel provider (`configureApoTelemetry`) that picks up the processor `registerApoTracing()` created, so spans reach both the local projection and the backend. If you're tracing **outside** a task run (a standalone service, a script), skip `registerApoTracing` and call [`configureApoTelemetry`](/reference/tracing/) directly — that's the path that owns the provider.
:::

:::caution[Wrap your agent calls in withApoRun]
The `ApoSpanProcessor` is global — it doesn't inherently know which run a span belongs to. `withApoRun(ctx, fn)` establishes the active run on Node's `AsyncLocalStorage`, and any OTel span emitted inside `fn` (including across `await` boundaries) is routed to the correct run. Omit the wrapper and spans won't be attributed to a run.
:::

### Run-context propagation

| Export | Signature | Purpose |
|---|---|---|
| `withApoRun` | `<T>(ctx: ApoRunContext, fn: () => Promise<T>) => Promise<T>` | Run `fn` with `ctx` as the active apo run. Spans inside it route to this run. |
| `withApoRunSync` | `<T>(ctx: ApoRunContext, fn: () => T) => T` | Synchronous variant. |
| `getActiveApoRun` | `() => ApoRunContext \| undefined` | Read the active run context (used internally by the processor). |
| `resetApoTracing` | `() => void` | Reset registration state — testing only. |
| `ApoSpanProcessor` | `class` | The OpenTelemetry `SpanProcessor` that translates GenAI spans into apo observations. |

## Manual wrappers (fallback)

`createApoOpenAI` and `createApoAnthropic` wrap your SDK client in a Proxy that records LLM and tool calls into the run's Flow automatically. Use these only for the raw `openai` / `@anthropic-ai/sdk` packages (which don't emit OTel on their own), or for custom clients and OpenAI-compatible endpoints where the standard OTel path doesn't fit.

### OpenAI JS SDK (`chat.completions.create`)

```typescript
import OpenAI from "openai";
import { createApoOpenAI } from "@apo/sdk/agent-task";

async sendUserTurn(turn, { trace, parentSpanId }) {
  const client = createApoOpenAI(
    new OpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" }),
    { trace, parentSpanId },
  );
  const response = await client.chat.completions.create({
    model: "google/gemini-2.5-flash-lite",
    messages: [{ role: "user", content: String(turn) }],
    tools,
  });
  return { response: response.choices[0].message.content ?? "" };
}
```

The wrapper returns a Proxy-wrapped client — every method works exactly as before. Non-streaming calls are traced; streaming calls pass through untraced.

### Anthropic JS SDK (`messages.create`)

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { createApoAnthropic } from "@apo/sdk/agent-task";

async sendUserTurn(turn, { trace, parentSpanId }) {
  const client = createApoAnthropic(
    new Anthropic({ apiKey }),
    { trace, parentSpanId },
  );
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: String(turn) }],
    tools,
  });
  const text = response.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("");
  return { response: text };
}
```

Same Proxy pattern as OpenAI. Anthropic's `tool_use` content blocks are captured as TOOL spans automatically.

## Trace primitives (escape hatch)

If you need to trace something the integrations don't cover, the trace context (`AgentTaskTraceContext`) carries low-level primitives you can call directly:

```typescript
async sendUserTurn(turn, { trace, parentSpanId }) {
  const result = await trace.traceTool("read_file", { path: "spec.md" }, async () => {
    return readFile("spec.md");
  });

  // Or create a span by hand
  const spanId = trace.createSpan({
    parent_call_id: parentSpanId,
    step_name: "my-custom-step",
    observation_type: "TOOL",
    input: { query: "..." },
  });
  const output = await doSomething();
  trace.endSpan(spanId, { output });

  return { response: "done" };
}
```

Available primitives on `AgentTaskTraceContext`:

| Method | What it does |
|---|---|
| `trace.traceTool(name, params, fn)` | Wraps a tool call. Automatically creates and ends a TOOL span. |
| `trace.traceRetriever(query, fn)` | Wraps a retrieval step. |
| `trace.traceAgent(name, fn)` | Wraps a sub-agent call. Creates an AGENT span. |
| `trace.traceChain(name, fn)` | Wraps a chain step. Creates a CHAIN span. |
| `trace.traceGuardrail(name, fn)` | Wraps a guardrail check. |
| `trace.traceEmbedding(model, input, fn)` | Wraps an embedding operation. |
| `trace.step(options, fn)` | Wraps an arbitrary timed step. |
| `trace.recordEvent(options)` | Records an instantaneous event (no duration). |
| `trace.score(params)` | Attaches a named score to the run. |
| `trace.createSpan(opts)` / `trace.endSpan(id, params)` | Low-level: create and end a span by hand. Use `observation_type: "TOOL"` or `"GENERATION"` for the Flow to pick it up. |

For tracing **outside** a task run (a standalone service or script that sends OTel to apo directly), see [Standalone OTel tracing](/reference/tracing/) — the `@apo/sdk/otel` module's `configureApoTelemetry` / `withApoTrace` path.

## See also

- [Adapters](/concepts/adapters/) — where `sendUserTurn` and the trace context live.
- [Assertions API](/reference/assertions/) — what `t.calledTool` and friends read from the run's trace projection.
- [Task API](/reference/task/) — the `task()`, `turn()`, `test()` calls.
- [Standalone OTel tracing](/reference/tracing/) — the `@apo/sdk/otel` module.
