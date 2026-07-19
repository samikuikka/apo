# Research asset — Ticket 03: Provider usage normalization

> AFK research gathered while resolving wayfinder ticket 03. This is the
> evidence base for the resolution. Cite `file:line` if you revisit.

## 1. apo's ingestion pipeline today (the choke point)

**Canonical OTLP path:**
- `POST /api/public/otel/v1/traces` (`backend/apo/routes/otlp_traces.py:44`) →
  `OtlpReceiver.ingest` (`backend/apo/services/otlp_receiver.py:197`) →
  persists `OtlpSpanDB` rows (attributes stored as a JSON column) →
  `TraceProjector.project` (`backend/apo/services/trace_projector.py:63`) →
  `normalize_span` → `_upsert_call` (`trace_projector.py:211`) →
  `_apply_cost` (`trace_projector.py:403`).

**Legacy adapter path** (`/api/v1/ingestion`): `legacy_adapter.py` builds
canonical spans and funnels through the same projector.

**Legacy direct-writer path** (`backend/apo/services/ingestion.py`): a
*separate, older* writer that writes `LoggedCallDB` **without** going through
the projector. It has its **own** cost-compute sites at `ingestion.py:150-151`
and `ingestion.py:257-261`. Both it and the projector call
`calculate_cost_for_model` (`cost_calculation.py:90`). Neither plumbs cached
tokens. → **There are two backend cost-compute sites, not one.** Any normalizer
design must address both.

**The choke point** (where dimensions get lost today):
`extract_tokens` (`backend/apo/services/otel_normalization/_shared.py:252-272`)
reads six generic alias paths and returns **only** `{"prompt", "completion"}`.
That flows through `NormalizedSpan.token_usage` and is frozen onto
`call.prompt_tokens` / `call.completion_tokens` in `_upsert_call`. By the time
`_apply_cost` runs, every other dimension is already gone. Cached/reasoning
tokens are **never extracted** anywhere in the backend today.

apo's `extract_tokens` reads, in priority order (first non-null wins):
`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`,
`gen_ai.usage.prompt_tokens`, `gen_ai.usage.completion_tokens`,
`ai.usage.promptTokens`, `ai.usage.completionTokens`,
`llm.token_count.prompt`, `llm.token_count.completion`.

## 2. apo's SDK emits only generic input/output, and is lossy

apo's SDK has exactly **one** site that writes usage attributes:
`packages/sdk/src/agent-task/otel-trace-client.ts:171-176` — sets only
`gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`.

The provider wrappers actively **discard** rich usage:
- `createApoOpenAI` (`packages/sdk/src/agent-task/integrations/openai.ts:71-85,
  133-140`) reads `response.usage.{prompt_tokens, completion_tokens}` —
  `total_tokens` isn't even on the interface, let alone cached/reasoning.
- `createApoAnthropic` (`.../integrations/anthropic.ts:61-72, 128-135`) reads
  `response.usage.{input_tokens, output_tokens}` — `cache_read_input_tokens`
  and `cache_creation_input_tokens` (which exist on real Anthropic responses)
  are not declared.
- Repo-wide grep across SDK packages: **zero hits** for `cached`, `cache_read`,
  `cache_creation`, `thoughts`. `reasoning` hits are all check/judge reasoning
  *text*, never tokens.

apo's SDK **forwards** upstream-GenAI-instrumentation spans verbatim
(`otel-processor.ts`, `otel-translate.ts`) — it doesn't rewrite them. So apo's
backend receives, over OTLP, whatever Vercel AI SDK / `openai-v2`
instrumentation / Claude Agent SDK native OTel / arbitrary-service
instrumentation emitted. apo is an OTel **sink** for arbitrary producers, not
just its own SDK.

apo's SDK has **no** GenAI instrumentation libraries as dependencies
(`packages/sdk/package.json:56-65`); `apo-otel-python` delegates to
`opentelemetry-instrumentation-openai-v2` when that extra is installed
(`packages/apo-otel-python/src/apo_otel/__init__.py:100-111`).

## 3. langfuse's normalizer (the reference)

Lives entirely in one file: `/home/sami/coding/langfuse/packages/shared/src/server/otel/OtelIngestionProcessor.ts`.
Entry point: `extractUsageDetails` (`:2222`). Shape: **not** a provider switch —
a sequential fallthrough ladder keyed on:

1. An explicit `usage_details` JSON blob wins verbatim (`:2227`).
2. Instrumentation-scope name: `"genkit-tracer"` (`:2235`), `"ai"` (Vercel AI
   SDK, `:2257`), `"pydantic-ai"` (`:2422`).
3. Within the `"ai"` scope, **key-membership** in the parsed
   `ai.response.providerMetadata` JSON: `"openai" in parsed` (`:2316`),
   `"anthropic" in parsed` (`:2330`), `"bedrock" in parsed` (`:2377`).
4. Generic fallback `extractGenericGenAiUsageDetails` (`:2427`).

**langfuse does NOT dispatch on `gen_ai.system`.** That attribute is read
elsewhere (`:2125`) but only to populate `modelParameters.system`, not to route
usage. The ticket's candidate-signals list was wrong about this.

### Per-provider mappings (exact source keys → canonical keys)

- **OpenAI** (inside `"ai"` scope, `:2316-2327`):
  `openai.cachedPromptTokens` → `input_cached_tokens`;
  `openai.acceptedPredictionTokens` → `accepted_prediction_tokens`;
  `openai.rejectedPredictionTokens` → `rejected_prediction_tokens`;
  `openai.reasoningTokens` → `output_reasoning_tokens`. Uses `??=` so
  `ai.usage.cachedInputTokens` / `ai.usage.reasoningTokens` (`:2296-2309`)
  take precedence.

- **Anthropic** (`:2330-2373`): reads from
  `anthropic.usage.{cache_creation_input_tokens, cache_read_input_tokens,
  cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}}`.
  Maps to `input_cache_creation`, `input_cached_tokens`,
  `input_cache_creation_5m`, `input_cache_creation_1h`. **The decrement**
  (`:2365-2371`): redefines `input_cache_creation` =
  `max(input_cache_creation - 5m - 1h, 0)` so the three buckets are
  non-overlapping.

- **Bedrock** (`:2377-2396`): `bedrock.usage.cacheReadInputTokens` →
  `input_cache_read`; `cacheWriteInputTokens` → `input_cache_write`;
  `cacheCreationInputTokens` → `input_cache_creation`.

- **Generic fallback** (`:2430-2541`): strips `gen_ai.usage.` / `llm.token_count.`
  prefixes, tries alias lists per canonical slot — 13 alias strings across 5
  slots (input, output, total, cache_read, cache_creation). Passes unknown keys
  through with `details.` prefix stripped.

### Non-overlap invariant — enforced per-branch, with gaps

- AI SDK / OpenAI / Anthropic / Bedrock path subtracts 5 input buckets +
  1 output bucket (`:2400-2408`, `:2410-2414`).
- Bedrock's `input_cache_write` is **not** subtracted from `input` (bug —
  double-counts).
- Generic path subtracts only cache_read + cache_creation from input, nothing
  from output (`:2517-2522`).
- Genkit subtracts thoughts from output (`:2247-2253`).

→ "Adopt langfuse's invariant" is **not** a single rule. apo must make it
uniform (decision 4 in the resolution).

### Unknown / unsupported handling

No error path, no explicit unsupported branch. Pure fallthrough: unrecognized
provider → generic extractor → minimal `{input, output, total}` or `undefined`.
Generic extractor passes unknown keys through (after stripping `details.`).

### Things langfuse does NOT do

- **No Gemini handling.** Grep across the langfuse repo: zero hits for
  `thoughts_token_count`, `candidates_token_count`, per-modality buckets in
  the normalizer. Gemini falls through to the generic extractor. The ticket's
  "Context" list was wrong about this too.
- **No single canonical schema enforced in the normalizer** — output is
  `Record<string, unknown>`; the downstream `RawUsageDetails` zod schema is a
  permissive record filtered to non-negative integers.

## 4. Gemini emission is unstable across libraries (the feasibility check)

Three **incompatible** vocabularies, each internally consistent, all
documented:

| Emitter | Vocabulary | Reasoning? | Cached? |
|---|---|---|---|
| Official `opentelemetry-instrumentation-google-genai` | `gen_ai.usage.*` (canonical semconv) | `gen_ai.usage.reasoning.output_tokens` | `gen_ai.usage.cache_read.input_tokens` |
| Arize `openinference-instrumentation-google-genai` | `llm.token_count.*` (OpenInference) | `llm.token_count.completion_details.reasoning` | `llm.token_count.prompt_details.cache_read` |
| Traceloop/openllmetry `opentelemetry-instrumentation-vertexai` | mixed; **typo'd** `gen_ai.usage.cache_read_input_tokens`; `llm.usage.total_tokens` | **dropped** | typo'd name |
| Vercel `@ai-sdk/google` | flat `gen_ai.usage.*` + `ai.usage.*TokenDetails.*` + minimal `providerMetadata.google` | `ai.usage.outputTokenDetails.reasoningTokens` | `gen_ai.usage.cache_read.input_tokens` |

Sources: `opentelemetry-python-genai/.../generate_content.py`,
`opentelemetry-python-contrib/.../opentelemetry-util-genai/_inference_invocation.py:137-164`,
`open-telemetry/semantic-conventions-genai/docs/gen-ai/gen-ai-spans.md:89-93,173-192`,
`traceloop/openllmetry/.../vertexai/span_utils.py:293-323`,
`Arize-ai/openinference/.../google_genai/_utils.py:38-99`,
`vercel/ai/packages/google/src/convert-google-usage.ts`,
`vercel/ai/packages/otel/src/supplemental-attributes.ts:164-181`.

**OTel GenAI semconv mandates** (`gen-ai-spans.md:173-192`):
`reasoning.output_tokens` **is included in** `output_tokens`; `cache_read.input_tokens`
**is a subset of** `input_tokens`. Summing naively double-counts. Official
instrumentation and AI SDK obey; OpenInference does **not** (it sets
`llm.token_count.prompt = prompt + tool_use_prompt`, cache counted separately).
A normalizer must know which convention each emitter follows.

This instability is exactly why Gemini needs a per-provider normalizer rather
than flowing through the generic resolver: the generic resolver would only
catch `input`/`output`, dropping the thinking-token billing dimension
(billed at output rate per the OpenInference/openllmetry convention) on every
Gemini thinking-model call. Architectural correctness over effort → ship the
Gemini normalizer in v1 despite the three dialects, since all three are
knowable and documented.

## 5. Decision-relevant takeaways (what reshaped the ticket)

1. The ticket's candidate-signals list for provider detection was wrong about
   langfuse. langfuse uses scope-name + `providerMetadata` key-membership, not
   `gen_ai.system`. → apo adopts a multi-signal hierarchy (decision 2).
2. langfuse doesn't handle Gemini. → apo does more than langfuse here, because
   apo's standing preference is correctness over effort (decision 3).
3. langfuse's invariant is per-branch with gaps. → apo makes it uniform
   (decision 4).
4. apo has two backend cost-compute sites. → the normalizer is a standalone
   callable function, invoked from both, not coupled to one call site
   (decision 5).
5. apo's SDK is lossy today. → the SDK must change from "read 2 fields,
   discard rest" to "forward full provider usage losslessly" as data plumbing
   (decision 1's cost; SDK does *not* do provider logic).
