---
title: "Standalone OTel tracing"
description: "Send OpenTelemetry traces to apo from any application — not just agent-task runs — via @apo/sdk/otel. The standard OTLP path that replaced the retired TraceTracker protocol."
---

`@apo/sdk/otel` sends traces to apo from any application, using standard OpenTelemetry. This is the lower-level tracing layer — you reach for it when you want apo's traces **outside** of an agent-task run (a production service, a background job, a script). Inside an agent-task run you don't need it; the task runner wires tracing up for you (see [Tracing integrations](/reference/tracing-integrations/)).

This module replaced the retired `TraceTracker` custom protocol (removed in SPEC-129). It is plain OTel: the official OTLP/HTTP exporter, standard semantic conventions, and a real OTel `Resource`. No custom wire format.

```typescript
import { configureApoTelemetry } from "@apo/sdk/otel";

const apo = await configureApoTelemetry({
  takeOwnership: true,
  endpoint: "https://apo.internal.company.com/api/public/otel/v1/traces",
  serviceName: "billing-agent",
  publicKey: process.env.APO_PUBLIC_KEY,
  secretKey: process.env.APO_SECRET_KEY,
});
```

## `configureApoTelemetry` — the entry point

Builds apo's trace export from official OTel components and returns a handle. `takeOwnership: true` is **required** — it is explicit permission for this helper to own the OTel provider lifecycle (create the provider, register it globally if asked, shut it down). This guard exists because OTel JS 2.x does not allow mutating a provider after construction, so ownership must be claimed at the boundary.

| Option | Purpose |
|---|---|
| `takeOwnership: true` | **Required.** Lets the helper own the OTel lifecycle. |
| `endpoint` | Full OTLP traces URL. Falls back to `APO_OTLP_ENDPOINT`, then `http://localhost:8000/api/public/otel/v1/traces`. |
| `serviceName` | OTel resource `service.name` (required). Defaults to `"apo-agent"`. |
| `serviceVersion`, `environment` | Optional OTel resource attributes. |
| `project` | Diagnostic resource attribute only. **Tenancy is determined by auth, not this field** — the project is set by the API key / service token. |
| `headers` | Auth headers (`Authorization: Basic/Bearer`). Falls back to headers derived from `APO_PUBLIC_KEY`+`APO_SECRET_KEY` or `APO_AUTH_TOKEN`. |
| `publicKey`, `secretKey` | Basic auth pair. Falls back to env vars. Used to build `Authorization: Basic base64(pk:sk)`. |
| `authToken` | Bearer token. Falls back to `APO_AUTH_TOKEN`. Used only when `publicKey`/`secretKey` are absent. |
| `processor` | `"batch"` (default, for long-lived services) or `"simple"` (for short-lived jobs). |
| `registerGlobal` | Register as the global tracer provider. Defaults to `false`; when `true`, only registers if no global provider exists yet — apo never silently replaces one. |

The returned `ApoTelemetryHandle` carries the `tracer`, the `provider`, and `forceFlush()` / `shutdown()` for graceful teardown.

## `withApoTrace` — the main span helper

Creates a root or child span using standard OTel context, runs your function with the span active, and ends it. Child spans created inside inherit the active context — correct nesting for free.

```typescript
import { configureApoTelemetry, withApoTrace } from "@apo/sdk/otel";

const apo = await configureApoTelemetry({
  takeOwnership: true,
  endpoint: "https://apo.internal.company.com/api/public/otel/v1/traces",
  headers: { Authorization: `Basic ${btoa("pk-apo-...:sk-apo-...")}` },
  serviceName: "extract-parties",
});

const result = await withApoTrace({ name: "extract-parties" }, apo.tracer, async (span) => {
  span.setAttribute("gen_ai.request.model", "gemini-2.5-flash-lite");
  const response = await callLLM(prompt);
  return response;
});

await apo.shutdown(); // flush + tear down
```

Set attributes using GenAI semantic conventions (`gen_ai.*`) so the backend normalizer extracts model, tokens, input, and output into structured fields.

## Observation helpers

For the common observation kinds, the SDK exports typed wrappers. Each starts a span, sets the right `apo.observation.type`, runs your function, and ends the span:

```typescript
import { traceTool } from "@apo/sdk/otel";

const content = await traceTool(
  apo.tracer,
  "read_file",
  { path: "contract.pdf" },
  async () => readFile("contract.pdf"),
);
```

`traceTool` sets `gen_ai.tool.name`, `gen_ai.tool.call.arguments`, and `gen_ai.tool.call.result` for you, so the backend normalizer classifies the span as a `TOOL` observation.

| Helper | Signature | Observation kind |
|---|---|---|
| `traceTool(tracer, name, params, fn)` | `(tracer, name: string, params: object, fn: () => Promise<T>) => Promise<T>` | `TOOL` |
| `traceAgent(tracer, name, fn)` | `(tracer, name: string, fn: () => Promise<T>) => Promise<T>` | `AGENT` |
| `traceChain(tracer, name, fn)` | `(tracer, name: string, fn: () => Promise<T>) => Promise<T>` | `CHAIN` |
| `traceRetriever(tracer, query, fn)` | `(tracer, query: string, fn: () => Promise<T>) => Promise<T>` | `RETRIEVER` |

`apo.observation.type` must be one of the valid kinds: `GENERATION`, `SPAN`, `TOOL`, `CHAIN`, `RETRIEVER`, `EVALUATOR`, `EMBEDDING`, `GUARDRAIL`, `AGENT`. An out-of-vocabulary value is ignored and the span falls through to generic classification.

## Attaching a score

`score(params, config)` records a named score against a specific trace (or a single observation within it). It calls the native score API directly — a score is an apo domain record, not a span. Unlike the trace-context `trace.score(...)` method available inside a task run, this standalone form takes an explicit `traceId` and the backend `config` (endpoint + auth headers), since it has no ambient run to attach to.

```typescript
import { score, buildApoAuthHeaders } from "@apo/sdk/otel";

await score(
  { traceId: "abc123...", name: "accuracy", value: 0.92, dataType: "NUMERIC", source: "EVAL" },
  { endpoint: "https://apo.internal.company.com", headers: buildApoAuthHeaders(publicKey, secretKey) },
);
```

Pass `observationId` in `params` instead of `traceId` to attach the score to a single observation rather than the whole trace.

## Host-owned providers

If your application already owns an OTel provider, do **not** call `configureApoTelemetry` — it claims ownership. Instead, construct apo's processor and add it to your provider's `spanProcessors` array:

```typescript
import { createApoSpanProcessor } from "@apo/sdk/otel";

const processor = createApoSpanProcessor({
  endpoint: "https://apo.internal.company.com/api/public/otel/v1/traces",
  headers: { Authorization: `Basic ${btoa("pk-apo-...:sk-apo-...")}` },
  processor: "batch",
});

// add `processor` to your BasicTracerProvider's spanProcessors at construction time
```

`createApoSpanProcessor` has no global side effects and transfers lifecycle ownership to your provider.

## Configuration

`configureApoTelemetry` resolves each option from the argument, then the matching env var, then a default. The env vars:

| Env var | Purpose |
|---|---|
| `APO_OTLP_ENDPOINT` | OTLP traces endpoint. |
| `APO_PROJECT` | Diagnostic resource attribute only (tenancy is auth-derived). |
| `APO_PUBLIC_KEY` | Public key (`pk-apo-…`). Pairs with `APO_SECRET_KEY` for Basic auth. |
| `APO_SECRET_KEY` | Secret key (`sk-apo-…`, server-side). |
| `APO_AUTH_TOKEN` | Bearer token. Used only when the public/secret pair is absent. |

:::caution[The "public" key is a write credential]
Despite the name, the `pk-apo-…` public key can **write traces** into your project on its own — it does not require the secret key for ingestion. Anyone who has the public key can send forged spans that pollute your project's data.

Treat `pk-apo-…` keys as secrets in practice: do not commit them, do not log them, and only expose them in client-side code if you accept that anyone who reads the client can write traces to your project. The secret key (`sk-apo-…`) grants full API access and must never be exposed client-side.
:::

## Errors

- `ClientError` / `ConfigurationError` — raised for client setup problems (missing endpoint, invalid keys). `ClientErrorCode` enumerates the cases. Exported from `@apo/sdk`.

## See also

- [Traces](/concepts/traces/) — what a trace is and how the dashboard renders it.
- [Tracing integrations](/reference/tracing-integrations/) — tracing inside an agent-task adapter (the common case; the task runner handles telemetry setup for you).
- [Configuration](/reference/configuration/) — the full env-var catalog.
