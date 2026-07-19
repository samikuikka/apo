---
title: Flow normalizers
description: "Convert an existing agent log (OpenAI, Anthropic, or Vercel AI SDK) into apo's Flow format, so trace assertions work without an adapter."
---

If your agent already runs outside apo — built on the OpenAI, Anthropic, or Vercel AI SDK — you can convert a **recorded log** of that run into apo's `Flow` format, then inspect it with `FlowView`.

This is the "bring your existing agent" path: you already have agent runs logged as message arrays or result objects, and you don't want to re-run the agent through apo's adapter to examine them.

:::caution[Deprecated — prefer OTel]
The Flow converters and `FlowView` are **compatibility adapters**, kept for the transition. New integrations should emit standard OpenTelemetry spans instead of producing a Flow — the task runner consumes OTel natively, and live `t.*` assertions read the [trace projection](/reference/assertions/) (`TraceView`), not a `Flow`. See [Tracing integrations](/reference/tracing-integrations/) for the OTel path. `FlowView` remains the way to inspect a recorded log by hand.
:::

## When to use a normalizer vs an adapter

| | Adapter | Normalizer |
|---|---|---|
| **Source** | apo drives your agent *live* | you feed in a *recorded* log |
| **Runs the agent?** | yes | no — it reads a past run |
| **Status** | the primary path | deprecated escape hatch, for logs you already have |

If your agent *can* run live through apo, use an [adapter](/concepts/adapters/) — that's the primary path. Normalizers exist for when you can't or won't re-run the agent (a production trace, an eval harness's stored output) but still want to see what it did.

## The three converters

All three take their SDK's native message/result shape and return a `Flow`. Import them from `@apo/sdk/agent-task`:

### `fromOpenAIMessages(messages)`

Converts a standard OpenAI chat-completions log. Extracts user/assistant messages and tool calls, resolving tool outputs from the matching `role: "tool"` messages.

```typescript
import { fromOpenAIMessages } from "@apo/sdk/agent-task";

const flow = fromOpenAIMessages([
  { role: "user", content: "Summarize this contract" },
  { role: "assistant", content: null, tool_calls: [
    { id: "call_1", function: { name: "read_file", arguments: '{"path":"contract.pdf"}' } },
  ]},
  { role: "tool", tool_call_id: "call_1", content: "Acme Corp hereby..." },
  { role: "assistant", content: "The contract is between Acme Corp and..." },
]);
```

### `fromAnthropicMessages(messages)`

Converts Anthropic content blocks (`text`, `tool_use`, `tool_result`), resolving tool outputs from matching `tool_result` blocks.

```typescript
import { fromAnthropicMessages } from "@apo/sdk/agent-task";

const flow = fromAnthropicMessages([
  { role: "user", content: [{ type: "text", text: "Summarize this contract" }] },
  { role: "assistant", content: [
    { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "contract.pdf" } },
  ]},
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_1", content: "Acme Corp hereby..." },
  ]},
  { role: "assistant", content: [{ type: "text", text: "The contract is between..." }] },
]);
```

### `fromAISDK(result)`

Converts a Vercel AI SDK `generateText` / `streamText` result. Each step's text becomes a message; tool calls become Flow events with resolved outputs.

```typescript
import { generateText } from "ai";
import { fromAISDK } from "@apo/sdk/agent-task";

const result = await generateText({
  model: openai("gpt-4o"),
  tools: { read_file, search_content },
  messages: [{ role: "user", content: "Review this code" }],
  maxSteps: 5,
});

const flow = fromAISDK(result);
```

## Reading the Flow

Once you have a `Flow`, inspect it with `FlowView` — a typed read-model over the recording. Construct one and read its derived getters:

```typescript
import { FlowView } from "@apo/sdk/agent-task";

const view = new FlowView(flow);

view.toolCalls;            // [{ name, input, output, status }, ...]
view.toolNamesInOrder;     // ["read_file", "search_content"]
view.reply;                // the last assistant message text
view.turnCount;            // number of assistant turns
view.failedActions;        // count of tool/subagent calls that errored
```

:::note[FlowView is for inspecting recordings, not live runs]
`FlowView` is the read-model for a recording you converted by hand. In a **live** task run, the `t.*` assertions query a different read-model — `TraceView`, built from the run's trace projection snapshot — which is what [Tracing integrations](/reference/tracing-integrations/) feeds. `FlowView` exists for the recorded-log case; the two are not interchangeable.
:::

`FlowView` is the only public way to assert against a converted recording today. The previous `runFlowChecks` helper that ran a registered test suite against a `Flow` was **removed** — the check runner now operates on the projection snapshot internally (`runTraceChecks`, not part of the public SDK surface). To run a full registered test suite against a run, drive it through the task runner, which builds the projection for you. (`test(...)` still registers into a shared global registry that throws on duplicate ids; the task runner calls `resetFlowChecks()` before loading each task's tests.)

## Input types

### `OpenAIMessage`

```typescript
interface OpenAIMessage {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
}
```

### `AnthropicMessage`

```typescript
interface AnthropicMessage {
  role?: string;
  content?: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input?: unknown }
    | { type: "tool_result"; tool_use_id: string; content?: unknown }
  >;
}
```

### `AISDKResult`

```typescript
interface AISDKResult {
  steps?: Array<{
    text?: string;
    toolCalls?: Array<{ toolName: string; input?: unknown }>;
    toolResults?: Array<{ toolName: string; output?: unknown }>;
  }>;
}
```

## See also

- [Adapters](/concepts/adapters/) — the primary path (apo drives your agent live).
- [Assertions API](/reference/assertions/) — the full `t.*` assertion vocabulary.
- [Ecosystem](/ecosystem/) — example adapters and CI integration.
