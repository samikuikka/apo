# 05 — Conditional pricing: tier condition engine

**Type**: Grilling (HITL) · **Status**: closed · **Claimed by**: wayfinder-session-2026-07-22 · **Blocked by**: 02

## Question

How does apo express conditional pricing that depends on the call itself —
Gemini's >200K-context price tier, batch pricing, service-tier pricing — as a
declarative layer rather than hardcoded `if model == …` branches?

This is the harder half of "conditional pricing is a declarative layer on top"
(locked decision 1). Time-windowing (ticket 04) is the easy half.

### Context (from research)

langfuse's tier engine (`packages/shared/src/server/pricing-tiers/matcher.ts`):

- A model has many `PricingTier`s; each tier has many `(usage_key, price)` rows.
- One tier is `isDefault`; others have `priority` (lower = checked first) and
  `conditions: [{usageDetailPattern, operator, value, caseSensitive}]`.
- `usageDetailPattern` is a regex; the matcher **sums all usage-detail keys whose
  names match the regex**, then compares the sum to `value` with the operator
  (`gt`/`gte`/`lt`/`lte`/`eq`/`neq`).
- The first tier (by priority) whose conditions all pass wins; else the default
  tier.

Example: Gemini 2.5 Pro has a "Large Context" tier, priority 1, condition
`{usageDetailPattern: "(input|prompt|cached)", operator: "gt", value: 200000}`.
If input + cached > 200K, the higher-priced tier kicks in.

### To decide

- **Adopt langfuse's engine as-is, or simplify?** The regex-sum-vs-threshold
  design is flexible but has a known limitation: `value` is numeric-only, so it
  can't express "batch" / "service-tier" string-attribute conditions (those
  would need string equality, which langfuse punts on). Does apo need string
  conditions? If yes, the engine needs extending.
- **Scope of conditions**: usage-sum-vs-threshold only (langfuse), or also
  string-attribute equality (for batch/service-tier), or also call-metadata
  fields beyond usage? Each extension is generality-vs-complexity.
- **Validation**: langfuse enforces (a) exactly one default tier per model, (b)
  all tiers declare the same usage_key set (so a matched tier always has a price
  for every present key), (c) regex safety / catastrophic-backtracking rejection.
  Which of these does apo adopt?
- **Tier + time-window interaction**: a tier is matched on usage; a window is
  matched on time. Do they compose as "match window first, then tier within
  window"? Confirm the resolution order.
- **Default-tier fallback**: if no tier's conditions pass, the default tier
  prices the call. Confirm apo wants this (vs erroring on unmatched).

### Scope

Decides the tier engine's expressiveness, validation rules, and resolution
order. The *implementation* is spec work. This ticket's validation decisions
graduate the map's "Validation rules" fog line.

---

## Resolution

**Resolved 2026-07-22.** Five decisions. Of the ticket's five "to decide"
bullets, two (#4 resolution order, #5 default-tier fallback) were already
locked by ticket 04; the rest collapse to a single, obvious engine shape once
the real-world usage data is examined.

The decisive fact: across langfuse's 156 tiered default models, **every tier
condition is the same shape** — an input-token sum vs a `gt` threshold (the
large-context tier). The other five operators (`lt`/`lte`/`eq`/`neq`) and the
arbitrary-regex-sum machinery are never exercised. Batch/service-tier pricing
is inexpressible (`value` is numeric-only) and apo's SDK doesn't capture
`service_tier` today, so that capability is unreachable regardless. The full
langfuse engine is general-purpose machinery bought for a single real use
case.

1. **Engine shape — threshold-only (langfuse-minimal).** A condition is
   `{keys: [canonical_key, …], operator, threshold}` where `operator ∈
   {gt, lt, gte, lte}`. Match = sum the named canonical usage keys, compare
   to the threshold. `eq`/`neq` dropped (never used; exact-equality on a
   token sum has no real pricing meaning). **No regex engine at all** — the
   arbitrary-regex-sum matcher is removed entirely, which also eliminates
   catastrophic-backtracking as a concern (validation rule B becomes moot).
   Batch/service-tier (string-attribute conditions) are out of scope for this
   engine and graduate to map fog until apo captures the metadata.

2. **Condition keys — sum a set of canonical keys.** A condition names a
   list of canonical usage keys to sum (not a single key, not a regex). This
   reproduces langfuse's `(input|prompt|cached)` intent correctly under apo's
   canonical-key world (ticket 03 normalizes to canonical keys, so naming
   them directly is unambiguous). The canonical large-context tier sums the
   **read-side family** (`input + cache_read`): cached tokens occupy the
   context window, so a call with 150K input + 100K cache_read = 250K context
   must trip the surcharge — a single-key `input > 200K` condition would miss
   it. `cache_write_*` keys are excluded (write-side, not read-side occupancy).

3. **Tier matching — langfuse's algorithm.** Non-default tiers evaluated in
   ascending `priority` order; first tier whose conditions all pass (AND
   logic) wins; else the default tier. `priority` is a per-model integer,
   lower = checked first.

4. **Resolution order — confirmed from ticket 04 (not re-decided).** Model-era
   (time-window) → tier → prices. Tier conditions are usage-only, never time
   (a tier is matched on the call's usage within the era already selected).
   The default tier is the fallback when no tier's conditions pass (confirmed;
   apo does not error on unmatched).

5. **Validation rules.**
   - **(A) Exactly one default tier per model** — enforced at write time. The
     matcher falls back to default, so zero or two defaults is a bug.
   - **(B) Regex safety — N/A.** No regex engine (decision 1), so no
     catastrophic-backtracking rejection is needed.
   - **(C) Same usage_key set across all tiers of a model** — enforced at
     write time. Guarantees a matched tier always has a price for every key
     the model prices; no surprises at compute time. For apo's 6 canonical
     keys and rare tiered models the cost of copying a base price into every
     tier is negligible, and it matches ticket 01's "unknown = store-but-
     unpriced" boundary by keeping pricing complete on the keys a model does
     price. (Rejected alternative: tolerate missing keys at price 0 — risks
     silent underpricing when a model author forgets a key on a tier.)

### Hands off to

- **Ticket 06** (compute & storage): the tier match result carries
  `(tier_id, tier_name, prices: {usage_key → micro-USD})`; compute sums
  `prices[k] × raw_usage[k]` over canonical keys present in both. Store the
  matched `tier_id`/`tier_name` on the call (langfuse stores
  `usage_pricing_tier_id`/`name` — useful for debugging "why this price").
- **Ticket 07** (JSON defaults): tier entries in the file carry `priority`,
  `isDefault`, `conditions: [{keys, operator, threshold}]`, `prices:
  {usage_key → micro-USD-per-million}`. Validation rules A and C apply on
  load.
- **Ticket 10** (API): the match/preview endpoint takes a usage map and
  returns the matched tier + per-key breakdown.

### Out of scope for this ticket

- Batch / service-tier / string-attribute conditions — graduate to map fog
  (apo's SDK doesn't capture `service_tier` today; the engine can't be
  exercised even if it supported it).
- `eq`/`neq` operators — no known pricing meaning on a token sum.
- Specific tier entries / prices — data, in the JSON defaults (ticket 07).
