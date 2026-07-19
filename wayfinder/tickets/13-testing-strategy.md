# 13 — Testing strategy

**Type**: Grilling (HITL) · **Status**: open · **Claimed by**: — · **Blocked by**: —

## Question

What gets property-tested vs unit-tested across the cost system, and where do
the fixture corpora come from?

The shapes are now all decided (tickets 01–06), so the testing *targets* are
known. This ticket decides the *strategy*: which components earn property
tests (invariants over generated input) vs focused unit tests (known
fixtures), and what real-world usage data feeds them.

### Context

The decided shapes, and their testing implications:

- **Normalization (ticket 03):** per-provider mapping → canonical keys, with
  the non-overlap invariant (cache/reasoning subtracted from input/output,
  per OTel GenAI semconv). The invariant is the natural property-test target
  (generated usage maps, assert non-overlap after normalization). Per-provider
  mapping correctness is unit-test territory (one fixture per provider's
  documented usage shape).
- **Tier matching (ticket 05):** threshold-only engine, sum-of-keys vs
  threshold, priority order, default fallback. Simple enough for exhaustive
  unit tests; property-testing (random tier configs) has marginal value over
  good fixtures.
- **Time-windowing (ticket 04):** half-open `[start, end)`, one-era-active
  invariant. The "late-arriving span prices at its era" rule is the
  interesting case — worth a property test over `(call.start_time, era
  bounds)` triples.
- **Cost compute (ticket 06):** `breakdown[k] = price[k] × units[k]`,
  round-per-dimension, total = sum. Reconciliation (sum-of-breakdown == total)
  is the property; precedence (provided-wins) is unit-testable.

### To decide

- **Property vs unit split per component.** Recommendation: property-test
  the *invariants* (non-overlap in normalization; sum-coherence in compute;
  era-matching in windowing), unit-test the *mappings* (per-provider
  normalization; tier-priority selection; precedence rule). Confirm or
  adjust.
- **Fixture corpus for normalization.** Real provider usage payloads (from
  OpenAI/Anthropic/Bedrock/Gemini docs or captured SDK output) are the gold
  standard. Does apo capture any today? If not, hand-build from provider docs
  (v1 = 4 providers × a few payload shapes each). Decide source.
- **Rounding/reconciliation harness.** The micro-USD int round-per-dimension
  rule needs a harness that generates `(prices, units)` pairs and asserts
  `sum(round(breakdown)) == total`. Confirm this is worth a dedicated
  property test vs covered by compute unit tests.
- **Golden-model corpus for pricing.** A small set of real models (one
  large-context-tiered like Gemini 2.5 Pro, one flat-priced, one with cache
  tiers) with hand-verified expected costs, reused across tier-match +
  compute + re-price tests. Decide the set (3–5 models).
- **Integration boundary.** Where does the unit/property layer stop and a
  full ingestion-integration test start? The projector's `_apply_cost` is the
  seam. Confirm one integration test per ingestion path (projector +
  legacy direct-writer) that asserts the frozen stored fields.

### Scope

Decides the test strategy and fixture sources. The *writing* of the tests is
spec/implementation work. Graduated from map fog once tickets 05/06 (the
pricing/tier-matching shapes) landed.
