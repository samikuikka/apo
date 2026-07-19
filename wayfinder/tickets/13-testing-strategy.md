# 13 — Testing strategy

**Type**: Grilling (HITL) · **Status**: closed · **Claimed by**: cost-session-12 · **Blocked by**: —

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

---

## Resolution

**Resolved 2026-07-22.** The ticket body leaned toward property tests for the
invariants (non-overlap in normalization; sum-coherence in compute; era-matching
in windowing). Zooming into apo's actual test infrastructure changed that lean:
**apo has zero property-testing infrastructure** — no `hypothesis`, no
`fast-check`, not a single `@given` or `@st.` anywhere across backend, dashboard,
SDK, or CLI. Property tests would mean introducing a new dependency, a new test
discipline, and a new mental model for a pre-1.0 codebase whose entire existing
corpus is parametrized JSON fixtures and inline helpers. That's the wrong
trade-off for correctness *here*. The strategy below fits what exists.

### The governing facts (from the codebase)

- **Backend:** plain `pytest` (no `pytest-asyncio`, no coverage plugin); the CI
  gate is `uv run pytest -x -q` + `basedpyright --level error`. No frontend test
  runs in CI (`.github/workflows/ci.yml` frontend job is lint+typecheck only).
- **Two DB setups coexist**: conftest `client`/`session` (HTTP/route tests) vs
  `init_db()` + `apo.db.engine` + per-table `DELETE` teardown (projector, cost,
  parity tests — the latter seeds the 16 default models for free).
- **The fixture-corpus pattern** is already established and excellent:
  `backend/tests/fixtures/otel/*.json` carry `{description, source, input,
  expected}` and are parametrized via `@pytest.mark.parametrize` in
  `test_otel_fixtures.py`. This is the proven shape for "known payload → expected
  normalized output" contracts.
- **`_apply_cost` seam already has three layers** of coverage today
  (`test_cost_calculation.py`, `test_trace_projector.py`,
  `test_otel_projector_parity.py`) — but projector tests don't assert cost
  directly, and no cached-token / non-overlap / era-matching edge cases exist.

### 1. Unit tests over generated inputs — parametrized fixtures, not hypothesis

**Every "property" the ticket named becomes a parametrized fixture table
instead.** A property test asserts "for all generated inputs, invariant holds";
the parametrized equivalent asserts "for these N hand-chosen inputs (chosen to
hit the boundary cases), invariant holds." For apo's scale and team, the latter
is:

- **No new dependency**, no new discipline, fits the existing corpus pattern.
- **Boundary cases are hand-picked**, so the *interesting* cases (the ones that
  actually break) are guaranteed to run — a generator might never produce them.
- **Readable failures** — a failing parametrize case names the input; a
  hypothesis failure produces a shrinking trace few will read.
- **The corpus doubles as documentation** — a reader sees real provider payloads.

The cases a property test *would* find (e.g. an extreme token count that
overflows the micro-USD int) are instead covered by an explicit fixture chosen
for that purpose. The risk property testing uniquely catches — a case nobody
*thought* to write a fixture for — is accepted as a reasonable trade-off for a
pre-1.0 cost system whose inputs (provider usage maps) come in documented
shapes, not adversarial ones.

### 2. Per-component targets — what's unit-tested, and where

| Component | Test type | Target file | What it asserts |
|---|---|---|---|
| **Normalization (ticket 03)** | parametrized fixtures | `test_usage_normalization.py` | per-provider payload → canonical map; non-overlap invariant (cache/reasoning subtracted from input/output); unknown-key store-but-unpriced |
| **Tier matching (ticket 05)** | unit | `test_tier_matching.py` | threshold-only conditions, sum-of-keys, priority order, first-all-pass, default fallback; the `input+cache_read` large-context sum |
| **Time-windowing (ticket 04)** | unit | `test_time_windowing.py` | `[start,end)` matching; `NULL` end = open-ended; one-era-active invariant; the apo-specific temporal predicate (`start_date IS NULL` for legacy seed rows); late-arriving-span era selection |
| **Cost compute (ticket 06)** | unit | `test_cost_compute.py` | `breakdown[k] = price[k] × usage[k]`, round-per-dimension to micro-USD int, total = sum; provided-wins-verbatim precedence; skip-on-no-match; skip-on-missing-price |
| **Match endpoint (ticket 10)** | unit via `client` | `test_models_match.py` | usage-map input → tier+breakdown; anchored full-match semantics; era selection by `start_time` |

The tier/window/compute tests use the `init_db()` DB pattern (so they see seeded
models) — matching the existing `test_cost_calculation.py` setup at `:17-23`.

### 3. Fixture corpus for normalization — hand-built from provider docs, on disk

Source: **hand-built from provider documentation** (OpenAI, Anthropic, Bedrock,
Gemini), not captured SDK output — apo captures none today (confirmed: no
sample-usage JSON on disk beyond the OTel trace fixtures). The corpus lives at
`backend/tests/fixtures/usage/` as JSON in the established
`{description, source, input, expected}` shape (mirroring the OTel fixture
corpus), parametrized via `@pytest.mark.parametrize`.

The non-overlap invariant — the ticket's natural property-test target — is
asserted **in every normalization fixture's `expected`**: the fixture carries
the *post-normalization* map, and a shared assertion helper checks the
cache/reasoning values are subtracted from input/output (matching the OTel GenAI
semconv). So the invariant is checked on every real payload shape, not on
generated noise. v1 = 4 providers × ~3 payload shapes each (cached, reasoning,
plain) ≈ 12 fixtures — enough to cover the documented shapes without becoming a
maintenance burden.

### 4. Rounding/reconciliation — explicit fixtures, not a harness

The micro-USD round-per-dimension rule (ticket 06/02) gets **explicit edge
fixtures** rather than a generated harness: a fixture where per-dimension
rounding compounds (e.g. three dimensions each rounding down by 0.3 µ$ → total
differs from naive sum), asserting `sum(round(breakdown)) == total`. One or two
such fixtures cover the rounding edge; a full generator isn't justified for an
`int = sum(ints)` identity that can only fail if rounding direction is wrong.

### 5. Golden-model pricing corpus — 4 models, hand-verified

A small set of real models with hand-verified expected costs, reused across
tier-match + compute + re-price tests (ticket 12) + the match endpoint (ticket
10). Four models, chosen to exercise the distinct pricing shapes:

1. **A flat-priced model** (e.g. `gpt-4o-mini`) — baseline, no tiers, simple
   input/output.
2. **A large-context-tiered model** (e.g. `gemini-2.5-pro`) — exercises the
   `input + cache_read` sum condition crossing the threshold into the tier.
3. **A cache-tiered model** (e.g. `claude-sonnet-4.5`) — exercises
   `cache_read` / `cache_write_5m` / `cache_write_1h` as distinct priced
   dimensions (ticket 01's full read family).
4. **A reasoning model** (e.g. `o3`) — exercises the `reasoning` output
   dimension, and the unpriced-key skip (when `reasoning` has no price row).

These ship as JSON in the same `fixtures/usage/` corpus (or a sibling
`fixtures/pricing/`) and are the single source of "what's the right answer"
across the cost tests. Hand-verified means: a human computed the expected cost
from the provider's published per-1M prices + a known usage map, and recorded
it. This is the gold standard the ticket named; four models cover the four
pricing *shapes*, not the four most popular models.

### 6. Integration boundary — `_apply_cost` via the projector, both write paths

The projector's `_apply_cost` is the seam, as the ticket anticipated. **One
integration test per ingestion path**, asserting the full frozen stored field
set (ticket 06: `cost`, `cost_breakdown`, `raw_usage`, `tier_id`/`tier_name`,
`provided_cost`, provenance flag):

- **Canonical/projector path:** `test_trace_projector.py` (existing) — extend
  to assert cost is applied after `project()`, using a fixture span that carries
  a priced model + full usage. This is the gap the agent found: projector tests
  exist but don't assert cost today.
- **Legacy direct-writer path:** `test_ingestion_canonical_adapter.py`
  (existing) — extend to assert the same frozen fields after
  `/api/v1/ingestion` POST.

Both reuse the golden-model corpus (§5) so the expected frozen values are
hand-verified. The integration layer is thin: it asserts *that the seam freezes
the right fields*, not the math (the unit layer owns the math). One test per
path per golden model — 8 tests total, parametrized over the 4 models × 2 paths.

### 7. Migration tests — follow the established hand-rolled-schema pattern

Ticket 09's migration (float→int transform, drop columns/tables, JSON seed)
follows the **proven migration-test pattern** in
`test_metric_project_migration.py` / `test_projection_identity_migration.py`:
build a SQLite DB with the *old* schema via raw
`conn.exec_driver_sql("CREATE TABLE ...")`, insert legacy rows (including
float-USD costs and stale `model_definitions`), call the migration function,
assert the post-migration shape (costs now micro-USD int, `calculated_cost`
gone, `cost_breakdown`/`raw_usage`/provenance columns present, new 3-table shape
seeded from JSON). Uses a fresh local `create_engine("sqlite://")`, fully
isolated from the conftest engine — matching the existing pattern exactly.

### 8. Frontend tests — not gated by CI, so keep them proportionate

Since CI doesn't run vitest, dashboard cost-display tests (ticket 11's
dimension-grouping/sort/hide-zero/unpriced-amber logic, the mix bar) are
**local-developer guardrails, not merge gates**. They earn their place if the
layout logic is non-trivial (it is — family grouping + sort + hide-zero has
branches), but they don't need exhaustive coverage. A handful of unit tests on
the pure layout functions (the `cost_breakdown` → rendered-rows transform) is
the right level. The deleted `model-pricing.ts` tests are removed with the file.

### What the strategy does NOT include (and why)

- **No hypothesis/property-based testing introduced.** The invariants are real
  (non-overlap, sum-coherence, era-matching), but parametrized fixtures over
  hand-chosen boundary cases cover them without a new dependency/discipline.
  This is a defensible, proportionate choice for a pre-1.0 codebase — not a
  rejection of property testing in principle. If a future invariant resists
  fixture-ization (e.g. a parser over arbitrary input), hypothesis can be added
  then, scoped to that component.
- **No coverage threshold.** apo has no coverage tooling on the backend and no
  frontend test gate; adding one is a separate infrastructure decision outside
  this map's destination (making the cost system correct).
- **No e2e/Playwright cost tests.** The integration layer is the projector seam;
  UI e2e is disproportionate for the cost system's correctness.

### Hands off to the spec writer

- Test files listed in §2 are new; the existing `test_cost_calculation.py` is
  rewritten (the old single-table shape is replaced by the 3-table shape from
  ticket 02, so its fixtures and assertions change substantially — this isn't a
  patch).
- The `fixtures/usage/` and `fixtures/pricing/` corpora are created as part of
  implementation, sourced from provider docs + hand-verification (§3, §5).
- The projector + ingestion parity tests are *extended* (new cost assertions),
  not replaced.
- All new backend tests must pass under `uv run pytest -x -q` (the CI gate);
  frontend tests run locally via `pnpm --filter dashboard test`.

### Out of scope for this ticket

- Writing the tests (spec/implementation).
- Specific fixture JSON contents (sourced during implementation).
- A coverage gate (separate infra decision).
