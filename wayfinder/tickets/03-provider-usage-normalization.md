# 03 — Provider usage normalization at ingestion

**Type**: Research + Grilling (AFK research, HITL decision) · **Status**: closed · **Claimed by**: cost-wayfinder (session 1) · **Blocked by**: 01

## Question

How does apo normalize every provider's usage output to the canonical usage keys
(ticket 01), once, at the OTel ingestion edge — so the price table never has to
know about provider/SDK variance?

This is the messiest, most research-heavy ticket. It's also the one that makes
"add a provider without touching pricing code" actually true.

### Context (from research)

langfuse's normalizer lives in `packages/shared/src/server/otel/OtelIngestionProcessor.ts`
(~lines 2288–2541). It handles, per provider:

- **OpenAI**: `cachedPromptTokens` → `input_cached_tokens`;
  `reasoningTokens` → `output_reasoning_tokens`; prediction tokens.
- **Anthropic**: `cache_creation_input_tokens` (split into 5m/1h via nested
  `ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`, with the base
  decremented so buckets are non-overlapping); `cache_read_input_tokens`.
- **Bedrock**: `cacheRead` / `cacheWrite` / `cacheCreation`.
- **Gemini**: `thoughts_token_count` (thinking models); per-modality buckets;
  `candidates_token_count`.
- A generic OTel fallback that reads `gen_ai.usage.*` and `llm.token_count.*`
  attributes with many alias attempts.

apo's current extraction
(`backend/apo/services/otel_normalization/_shared.py:244–272`) reads a few
attribute paths but doesn't normalize provider-specific shapes — it just grabs
`input_tokens` / `output_tokens` and a model name.

### Research note — Chinese providers (recorded during ticket 01 grilling)

Surveyed GLM/Zhipu, Moonshot (Kimi K2/K2.6), MiMo (Xiaomi), DeepSeek (V3/R1),
Qwen3 (Alibaba). **All fit the existing 6 canonical keys; none bills a new
dimension.** They are OpenAI-compatible on the billing surface:

- **DeepSeek** — cache-hit input (auto disk cache, ~50-100× discount) /
  cache-miss input / output. R1 reasoning tokens billed at output rate.
  Maps to `cache_read` / `input` / `output` (+ `reasoning`).
  Sources: api-docs.deepseek.com/quick_start/pricing, /guides/kv_cache.
- **Moonshot Kimi** — cache-miss input / `prompt_cache_hit_tokens` / output.
  Maps to `input` / `cache_read` / `output`. Source: kimi.com/resources/kimi-k2-6-pricing.
- **Qwen3** — input / output / thinking tokens (billed as output) / prompt caching.
  Maps to `input` / `output` / `reasoning` (+ `cache_read`).
  Source: alibabacloud.com/help/en/model-studio/model-pricing.

Implication: adding these providers is normalizer work (this ticket) + JSON data
(ticket 07), **not** an enum change. The enum only grows when a provider bills a
genuinely new dimension (e.g. a separately-priced web-search bucket, tool-call
surcharge, image modality billed off the text-token rate).

### To decide (after research)

- **Where the normalizer lives** in apo's pipeline. Candidates:
  `services/otel_normalization/`, `services/trace_projector.py`, a new
  `services/usage_normalization/`. The locked design says "at ingestion" — pin
  the exact module and how it hooks into `_apply_cost`
  (`trace_projector.py:403–431`).
- **Provider detection**: how does the normalizer know which provider's shape
  it's looking at? OTel `gen_ai.system` / `ai.response.providerMetadata` /
  a model-name prefix (`anthropic/…`, `openai/…`) / heuristics? What's apo's
  canonical provider signal?
- **Which providers ship in v1**. OpenAI, Anthropic, Gemini, Bedrock, Cohere
  are the obvious set — confirm scope. OpenRouter-style prefixed names already
  appear in apo.
- **Non-overlap invariant**: cache variants must be subtracted from `input`,
  reasoning from `output`, so totals don't double-count. langfuse enforces this
  per-provider in the normalizer. Adopt the same invariant?
- **Unknown/unsupported providers**: what does the normalizer emit when it can't
  recognize the shape? (Coupled to ticket 01's "unknown keys" decision.)

### Scope

Decides the normalization architecture, provider detection, and the v1 provider
set. The *implementation* of each provider's mapping is spec work, not a
decision — but the **shape** of the normalizer (where it lives, how it's
extended per-provider, what invariants it enforces) is decided here.

### Asset to produce

A research summary (markdown) covering: the canonical provider signals in OTel,
each v1 provider's usage shape and its mapping to apo's canonical keys, and the
unknown-provider fallback. This becomes input to the build spec.

---

## Resolution

**Resolved 2026-07-21.** Six decisions, closing every open question above.
Research asset: [`assets/03-normalizer-research.md`](../assets/03-normalizer-research.md).
Several "Context" assumptions in the ticket were invalidated by the research
and corrected below.

1. **Normalizer site — Backend (langfuse model).** The backend ingestion path
   is the single normalization point. apo's SDK changes from "read two fields,
   discard the rest" to "forward the full provider usage object losslessly"
   (data plumbing — the SDK does *no* provider logic). Rationale: apo is an
   OTel *sink* for arbitrary producers (its own SDK, upstream GenAI
   instrumentation forwarded verbatim, raw OTLP from non-apo services, legacy
   JSON). Only the backend sees every span source, so the normalizer must live
   where every span passes. Matches the locked "adopt langfuse's core design."

2. **Provider detection — multi-signal hierarchy.** Dispatch is a layered
   pipeline, most-authoritative signal first:
   (a) `ai.response.providerMetadata` JSON key-membership (`"anthropic" in
   parsed`, `"openai" in parsed`, …) — carries the richest data (Anthropic
   5m/1h TTL split lives nowhere else).
   (b) `gen_ai.system` attribute (`"openai"`, `"anthropic"`, …) — the OTel
   semantic-convention signal; emitted by `openai-v2` instrumentation and
   apo-otel-python.
   (c) model-name prefix heuristic (`anthropic/`, `openai/`, OpenRouter-style)
   — last resort; apo's match already uses unanchored `re.search` today.
   (d) generic alias resolver as the universal fallback.
   Why not a single signal: apo can't control which signal upstream emitters
   set, and no single signal captures every billing dimension (the Anthropic
   TTL split exists only in `providerMetadata`; `gen_ai.system` is the only
   signal some instrumentation libs set). Each provider normalizer declares
   which signals it keys on; the dispatcher is generic. This is what makes
   "add a provider *or instrumentation library* without touching pricing code"
   true. (Corrects the ticket's Context, which assumed langfuse dispatches on
   `gen_ai.system` — it doesn't; it uses scope-name + `providerMetadata`
   key-membership.)

3. **v1 provider set — maximal feasible: OpenAI + Anthropic + Bedrock + Gemini
   + generic fallback.** Per-provider normalizers for the four providers where
   a billing dimension escapes the generic resolver: OpenAI (reasoning +
   cached + prediction tokens), Anthropic (5m/1h cache-creation TTL split — a
   distinct billing rate), Bedrock (cache read/write/creation under distinct
   attribute names), Gemini (thinking tokens, billed at output rate, dropped
   by every generic resolver). All four are added in v1 per the locked
   "architectural correctness over engineering effort" preference. Gemini is
   the highest-upkeep: three incompatible emitter vocabularies (official OTel
   `gen_ai.usage.*`, Arize OpenInference `llm.token_count.*`, openllmetry mixed
   + typo'd, plus Vercel AI SDK flat attrs) — all documented, all handled.
   Every OpenAI-compatible provider (Cohere, Qwen, DeepSeek, Moonshot, GLM,
   MiMo — per ticket 01's research) flows through the generic resolver
   correctly and needs no per-provider normalizer. (Corrects the ticket's
   Context, which assumed langfuse handles Gemini — it doesn't.)

4. **Non-overlap invariant — uniform subtract, all providers.** The
   normalizer is the single place that enforces: `input` excludes
   `cache_read` + `cache_write_5m` + `cache_write_1h`; `output` excludes
   `reasoning`. This is mandated by the OTel GenAI semconv
   (`gen-ai-spans.md:173-192`: `cache_read.input_tokens` is a subset of
   `input_tokens`; `reasoning.output_tokens` is included in `output_tokens`)
   and is what makes the per-key cost-sum formula (`Σ price[key]·units[key]`)
   correct — without it, `input` and `cache_read` both get priced and the call
   is over-billed. apo applies it uniformly across all providers, fixing
   langfuse's per-branch gaps (Bedrock `input_cache_write` not subtracted;
   generic path doesn't subtract reasoning). This is the "normalize once"
   principle made concrete: every downstream consumer (cost compute,
   breakdown display, re-pricing, CLI) sees already-net values and never
   re-derives them.

5. **Module site — new `backend/apo/services/usage_normalization/` module,
   replacing `extract_tokens`.** A standalone
   `normalize_usage(provider_signal, raw_attrs) -> dict[str, int]` function
   with per-provider helpers below it, mirroring the existing
   `services/otel_normalization/` sibling. It replaces what
   `extract_tokens` (`_shared.py:252-272`) does today: instead of returning
   `{"prompt", "completion"}`, it returns the full canonical usage map. That
   flows through a widened `NormalizedSpan.token_usage` into `_upsert_call`,
   which derives **both** the scalar `call.prompt_tokens` /
   `call.completion_tokens` (preserving the existing schema for aggregation
   compat) **and** the new `call.raw_usage` JSON column (ticket 02) from the
   one map — so the two representations cannot drift. `_apply_cost` then
   reads from `call.raw_usage`. Three properties that picked this over the
   alternatives:
   - **"Normalize once" is literally true** — no second raw-attr read inside
     `_apply_cost` (the alternative did exactly that).
   - **Scalars and raw map derive from one source** — eliminates drift.
   - **The legacy direct-writer path (`ingestion.py:150-151, 257-261`) is
     fixable, not bypassed** — that path never builds an `OtlpSpanDB`, so any
     normalizer coupled to span-persist or to `_apply_cost` is invisible to
     it. A standalone callable function is invoked from *both* sites: the
     projector via the widened `extract_tokens`, and the legacy writer
     directly with the flat body fields. One normalizer, two call sites,
     zero divergence — this is what makes ticket 09 (migration) tractable.

6. **Unknown handling — store-but-unpriced at both levels.** Literal
   enactment of ticket 01's locked decision 3 ("store-but-unpriced — data is
   never lost"), applied at the normalizer boundary:
   - **Unrecognized provider** → the multi-signal hierarchy finds no provider
     match, the generic alias resolver runs as the universal fallback. It
     extracts whatever `gen_ai.usage.*` / `llm.token_count.*` aliases it
     recognizes (at minimum `input` / `output`); everything else is preserved
     under its post-prefix-stripping name.
   - **Recognized provider, unknown keys** → the per-provider normalizer maps
     the keys it knows to canonical; any leftover provider-specific keys pass
     through under their original name.
   In both cases the full result populates `raw_usage` (ticket 02), and only
   canonical keys with a matching price get a `cost_breakdown` entry. Unknown
   keys are never silently dropped. Pairs with locked decision 2 (raw usage
   stored → re-pricing always possible): when a later normalizer upgrade
   learns what an unknown key meant, the re-pricing tool recovers its cost
   with no data loss.

### Out of scope for this ticket

- The exact attribute-path strings each per-provider helper reads (spec work;
  the research asset records the source shapes).
- SDK changes to forward raw usage (data plumbing; sized as the cost of
  decision 1, owned by the build spec, not a separate decision).
- Whether `internal_model_id` / `provided_model_name` on `LoggedCallDB` get
  repurposed (ticket 02 / migration territory).
- Performance / caching of provider detection (the map's "Caching strategy"
  fog line — decide after the compute pipeline ticket reveals the query
  pattern).
