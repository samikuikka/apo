---
title: OpenTelemetry framework setup
description: How to point standard OTel instrumentation at apo for OpenAI, Anthropic, Vercel AI SDK, LangChain, and custom applications.
---

# OpenTelemetry framework setup

apo accepts standard OTLP/HTTP traces from any OpenTelemetry-compatible
instrumentation. No apo-specific SDK is required — just point your existing
OTel exporter at apo's OTLP endpoint.

:::caution[Provider ownership]
If your application or framework already configures OpenTelemetry, keep that
provider and add apo's span processor when constructing it. Use the standalone
bootstrap only when apo is allowed to own the process-wide provider.
:::

## Common setup

All frameworks use the same endpoint:

```
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://your-apo-host:8000/api/public/otel/v1/traces
```

Authentication uses Basic auth with your apo API key pair:

```
Authorization: Basic base64(pk-apo-...:sk-apo-...)
```

## Python

For an existing Python provider, attach apo during provider setup:

```python
from apo_otel import create_apo_span_processor
from opentelemetry.sdk.trace import TracerProvider

provider = TracerProvider()
provider.add_span_processor(create_apo_span_processor(
    endpoint="http://localhost:8000/api/public/otel/v1/traces",
    public_key="pk-apo-...",
    secret_key="sk-apo-...",
))
```

The framework recipes below use the standalone bootstrap. The
`take_ownership=True` argument is deliberate: the call refuses to replace a
provider your application already installed.

### OpenAI

```python
from apo_otel import configure_apo_telemetry

handle = configure_apo_telemetry(
    take_ownership=True,
    endpoint="http://localhost:8000/api/public/otel/v1/traces",
    service_name="my-agent",
    public_key="pk-apo-...",
    secret_key="sk-apo-...",
)
handle.instrument_openai()

# Now all openai.ChatCompletion.create calls are traced automatically
from openai import OpenAI
client = OpenAI(api_key="sk-...")
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

### Anthropic

```python
from apo_otel import configure_apo_telemetry

handle = configure_apo_telemetry(
    take_ownership=True,
    endpoint="http://localhost:8000/api/public/otel/v1/traces",
    service_name="my-agent",
    public_key="pk-apo-...",
    secret_key="sk-apo-...",
)

# Use opentelemetry-instrumentation-anthropic
from opentelemetry.instrumentation.anthropic import AnthropicInstrumentor
AnthropicInstrumentor().instrument()

import anthropic
client = anthropic.Anthropic(api_key="sk-ant-...")
response = client.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
```

### LangChain / LangGraph

```python
from apo_otel import configure_apo_telemetry

handle = configure_apo_telemetry(
    take_ownership=True,
    endpoint="http://localhost:8000/api/public/otel/v1/traces",
    service_name="my-langchain-app",
    public_key="pk-apo-...",
    secret_key="sk-apo-...",
)

# LangChain emits OpenInference semantic conventions which apo normalizes
from opentelemetry.instrumentation.langchain import LangchainInstrumentor
LangchainInstrumentor().instrument()

from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage

llm = ChatOpenAI(model="gpt-4o")
result = llm.invoke([HumanMessage(content="Hello!")])
```

## TypeScript / Node.js

OTel JS 2.x providers accept span processors at construction time. Compose apo
there when the host owns telemetry:

```typescript
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { createApoSpanProcessor } from "@apo/sdk/otel";

const provider = new BasicTracerProvider({
  spanProcessors: [createApoSpanProcessor({
    endpoint: "http://localhost:8000/api/public/otel/v1/traces",
    headers: {
      Authorization: `Basic ${btoa("pk-apo-...:sk-apo-...")}`,
    },
  })],
});
```

`configureApoTelemetry` is the standalone path. It creates a dedicated
provider and returns the tracer, flush, and shutdown lifecycle to the caller.
It requires `takeOwnership: true` so this process-wide responsibility is
visible at the call site.

The explicit `endpoint` and `headers` in the recipes below are optional.
`configureApoTelemetry` reads them from env vars when omitted — the same ones
the Python bootstrap uses:

| Env var | Used for |
|---|---|
| `APO_OTLP_ENDPOINT` | OTLP traces endpoint (defaults to `http://localhost:8000/api/public/otel/v1/traces`) |
| `APO_PUBLIC_KEY` + `APO_SECRET_KEY` | Basic auth (`Authorization: Basic base64(pk:sk)`) |
| `APO_AUTH_TOKEN` | Bearer auth (used only when the key pair is absent) |
| `APO_PROJECT` | Diagnostic resource attribute |

So the recipes all collapse to `configureApoTelemetry({ takeOwnership: true })`
once those vars are set.

### Vercel AI SDK

For TypeScript, the recommended path is the **Vercel AI SDK** (`ai` + `@ai-sdk/openai` or `@ai-sdk/anthropic`). It emits `gen_ai.*` OTel spans natively when telemetry is enabled — model name, token usage, tool calls are all captured automatically. Your code has zero span boilerplate.

Register the OTel processor once at startup, then enable telemetry on each call:

```typescript
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { registerApoTracing } from "@apo/sdk/agent-task";

// Register once — reads APO_OTLP_ENDPOINT, APO_PUBLIC_KEY, etc. from env.
await registerApoTracing();

const client = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Enable telemetry on the call — the SDK does the rest.
const result = await generateText({
  model: client.chat("gpt-4o"),
  messages: [{ role: "user", content: "Hello!" }],
  experimental_telemetry: { isEnabled: true },
});
```

For Anthropic, swap `@ai-sdk/openai` → `@ai-sdk/anthropic` and `createOpenAI` → `createAnthropic`.

For the raw `openai` / `@anthropic-ai/sdk` packages (which don't emit OTel), use the `createApoOpenAI()` / `createApoAnthropic()` wrappers instead. See [Tracing integrations](/reference/tracing-integrations/) for details.

## Custom applications

Any application that emits standard OpenTelemetry spans works with apo:

```python
from apo_otel import configure_apo_telemetry
from opentelemetry import trace

configure_apo_telemetry(
    take_ownership=True,
    endpoint="http://localhost:8000/api/public/otel/v1/traces",
    service_name="my-custom-app",
    public_key="pk-apo-...",
    secret_key="sk-apo-...",
)

tracer = trace.get_tracer("my-app")
with tracer.start_as_current_span("my-operation") as span:
    span.set_attribute("apo.observation.type", "CHAIN")
    # ... your code ...
```

## What apo normalizes

apo's normalizer classifies every span through a priority chain — the first mapper that recognizes a span wins:

1. **apo override** — an explicit `apo.observation.type` attribute.
2. **OpenInference** — `openinference.span.kind` (LangChain / Arize Phoenix).
3. **GenAI standard** — `gen_ai.*` (OpenAI, Anthropic, Vercel AI SDK instrumentation).
4. **Vercel AI** — `ai.*` (the Vercel AI SDK's own span names).
5. **Generic fallback** — always `SPAN`.

A span carrying attributes from more than one convention is classified by whichever matches first in that order.

| Convention | Key | Maps to |
|---|---|---|
| apo override | `apo.observation.type` | One of the valid kinds below; an unrecognized value is ignored and the span falls through. |
| OpenInference | `openinference.span.kind` | `LLM`/`CHAT`→GENERATION, `TOOL`→TOOL, `RETRIEVER`→RETRIEVER, `RERANKER`→RETRIEVER, `AGENT`→AGENT, `CHAIN`→CHAIN, `EMBEDDING`→EMBEDDING |
| GenAI standard | `gen_ai.*` | GENERATION (with model + token usage extracted) |
| Vercel AI | `ai.*` | GENERATION, TOOL |
| (fallback) | — | SPAN |

Valid `apo.observation.type` values: `GENERATION`, `SPAN`, `TOOL`, `CHAIN`, `RETRIEVER`, `EVALUATOR`, `EMBEDDING`, `GUARDRAIL`, `AGENT`.

:::note[Some spans don't appear as calls]
Each span also carries a **disposition** — `observe`, `transparent`, or `drop`. Only `observe` spans become call rows in a trace. Vercel AI SDK wrappers like `ai.generateText` are `transparent`: they don't get a row, and their children (`ai.generateText.doGenerate`) reparent to the wrapper's parent. That's why a `generateText` span "disappears" but its `doGenerate` child shows up as the GENERATION call.
:::

Content capture (prompt/completion text) requires setting these env vars:

```
OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=span_only
```

:::note[Server policy wins]
Those variables decide what instrumentation emits. The Project's
`trace_content_policy` still decides what apo stores. Projects default to
`redacted`; `full` storage is an explicit Project setting.
:::
