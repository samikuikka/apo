# 01 — Define the canonical usage-key enum

**Type**: Grilling (HITL) · **Status**: closed · **Claimed by**: ZCode (cost session) · **Blocked by**: —

## Question

What is the canonical set of billable usage keys apo uses to price a model call?
Open-ended enum or closed? What are the initial members?

The whole system hangs off this: the price table is keyed by it, the ingestion
normalizer emits it, the cost breakdown stores it, the dashboard displays it.
It's decided first because every other ticket references it by name.

### Context (from research)

langfuse's canonical set (extracted from their default prices JSON) is large and
open — `input`, `input_tokens`, `input_text`, `input_audio`, `input_image`,
`input_cached_tokens`, `input_cache_creation`, `input_cache_creation_5m`,
`input_cache_creation_1h`, `input_cache_read`, `output`, `output_tokens`,
`output_text`, `output_audio`, `output_reasoning`, `output_reasoning_tokens`,
`thoughts_token_count`, `total`, plus provider-aliased variants
(`cache_read_input_tokens`, `cache_creation_input_tokens`, `candidates_token_count`,
`prompt_token_count`, …). They declare the *same* logical price under multiple
aliases because different SDKs emit different key names.

The design question: does apo adopt that "many aliases, normalizer dedupes"
approach, or a smaller "canonical enum only, normalizer maps everything to it"
approach? The locked design says normalization happens **once at ingestion to
canonical keys** — which argues for a small closed enum that the normalizer
targets, not langfuse's open alias-per-SDK approach.

### To decide

- Open vs closed enum.
- The initial member set (start small, grow as providers are added — every key
  must be a thing the ingestion normalizer can emit).
- How unknown keys are handled at ingestion (drop, store-but-unpriced, error).
- Whether aliases exist at all (a normalizer that targets canonical keys should
  make aliases unnecessary — confirm this).

### Scope

This ticket decides the enum and its semantics. It does *not* decide the price
table shape (ticket 02), the normalizer implementation (ticket 03), or what
prices each key gets (that's data, in the JSON defaults — ticket 07).

---

## Resolution

**Resolved 2026-07-20.** Four decisions, all closing the open questions above:

1. **Enum shape — closed-in-form, open-to-grow.** A small set of canonical
   priceable dimensions. The normalizer maps every provider's SDK keys onto
   these canonical names at ingestion, so the price table and breakdown storage
   never carry SDK variance. Grows deliberately over time via a one-line enum
   addition + JSON data (no schema change). This is the locked design's
   "normalization at ingestion to canonical keys" made concrete — not
   langfuse's alias-per-SDK approach.

2. **Initial member set (6):**
   - `input`
   - `cache_read`
   - `cache_write_5m`
   - `cache_write_1h`
   - `output`
   - `reasoning`

   `cache_write_5m` / `cache_write_1h` are separate because Anthropic bills its
   ephemeral cache tiers at different rates. `reasoning` covers OpenAI o-series
   and Gemini/Qwen thinking models. `total` is omitted — it's a derived sum, not
   a priceable row. Audio/image/embedding modality buckets graduate from fog
   when a provider bills one as a distinct rate (see ticket 03's research note:
   surveyed GLM, Moonshot, MiMo, DeepSeek, Qwen — all fit the existing 6).

3. **Unknown-key handling — store-but-unpriced.** Unrecognized usage keys are
   kept in the raw usage map (which tickets 02/06 store for re-pricing) but get
   no price assigned. Cost is computed only over the canonical keys that have a
   price. If a model underprices because a new dimension is unpriced, the
   operator adds the key + price + re-prices — data is never lost. Pairs with
   locked decision 2 (raw usage stored → re-pricing always possible).

4. **Aliases — none in the enum.** Aliases (different SDK key names for the same
   dimension — e.g. `prompt_tokens`, `input_tokens`, `prompt_token_count`,
   `cachedPromptTokens`, `prompt_cache_hit_tokens`, `thoughts_token_count`, …)
   live only inside the normalizer as a mapping table → canonical key. The price
   table, the breakdown storage, and the dashboard display keys are all
   canonical. This is what makes "add a provider without touching pricing code"
   true: adding DeepSeek means teaching the normalizer
   `prompt_cache_hit_tokens → cache_read`, not adding a price-table row.
