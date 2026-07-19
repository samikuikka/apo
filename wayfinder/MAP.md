# wayfinder:map — Cost system for apo

> **Tracker**: local-markdown. The map is this file; child tickets live in
> `wayfinder/tickets/<NN>-<slug>.md`. Claiming a ticket = editing it to add
> `Claimed by: <session>` at the top, before any work. Blocking is a body
> convention (`Blocked by: NN`), since local-markdown has no native deps. The
> frontier = open, unblocked, unclaimed tickets. Resolve at most one ticket per
> session.

## Destination

A cost system for apo that scales to many providers and models without code
changes, **architecturally correct for the long term**. Concretely: pricing is
a normalized `(model, usage_key) → price` data table with an open canonical
usage-key enum; provider output is normalized to those canonical keys once at
ingestion; conditional pricing (time-windowed and tier-based) is a declarative
layer on top of the base price table; cost is computed once at ingestion and
stored frozen, with the raw normalized usage kept so a re-pricing tool can
recompute on demand; the per-dimension cost breakdown is stored on every call;
defaults ship as a JSON file in the release.

The map is done when every design decision needed to write the build spec is
made — the spec, implementation, and merge to apo are post-map work (write a
spec in `specs/`, run via ralph, merge per AGENTS.md).

## Notes

**Domain.** LLM observability cost tracking. apo is self-hosted, single-binary,
SQLModel + SQLite backend, Next.js dashboard, OTel-based ingestion. Reference
implementation to learn from (not blindly copy): `/home/sami/coding/langfuse/`.
Current apo cost code: `backend/apo/services/cost_calculation.py`,
`backend/apo/models/pricing.py`, `apps/dashboard/src/lib/model-pricing.ts`.

**Skills every session should consult.** `/grilling` and `/domain-modeling`
(default for any decision ticket). `/prototype` when "how should it look" is the
question (dashboard display). Research tickets are AFK.

**Locked destination-level decisions (do not re-litigate).**

1. **Design shape** — adopt langfuse's core design, adapted to apo's stack:
   prices as data keyed by an open canonical usage-key enum; provider
   normalization at ingestion; conditional pricing (time + tier) as a
   declarative layer; compute-once-store-frozen. *Includes* the tier engine and
   time-windowing — they are part of "architecturally correct," not exotic
   extras.
2. **History** — cost is frozen at ingestion (a January call stays at January's
   rate, which is what was actually paid). A re-pricing tool recomputes
   historical cost on demand. Both the computed cost and the raw normalized
   usage are stored, so re-pricing is always possible.
3. **Display** — store the per-dimension cost breakdown on every call
   (input / cache_read / cache_write_5m / output / reasoning / …), not just a
   scalar total. Makes mispriced models debuggable after the fact.
4. **Price source** — defaults ship as a JSON file in the release, loaded and
   upserted into the DB idempotently on startup. No runtime fetch of
   third-party feeds. Per-project overrides still come via the API/DB. A
   maintenance workflow for keeping the JSON fresh is in-scope (see tickets).

**Standing preferences.** Architectural correctness over engineering effort.
SQLModel/SQLite, not Prisma/Postgres — adapt the design, don't port it. apo
stores everything in one place (no Postgres+ClickHouse split). Every decision
ticket should weigh: does this scale to N providers/models without code
changes? If no, it's wrong.

## Decisions so far

<!-- the index — one line per closed ticket: enough to judge relevance, then zoom the link for the detail the ticket holds -->

- [01 — Define the canonical usage-key enum](tickets/01-canonical-usage-key-enum.md) — closed-in-form enum of 6 canonical priceable keys (`input`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `output`, `reasoning`); SDK aliases live in the normalizer, not the enum; unknown keys are store-but-unpriced (kept in raw usage, no price).
- [02 — Cost data model](tickets/02-data-model.md) — 3-table shape (`models → pricing_tiers → prices`, keyed `(model_id, usage_key, tier_id)`); INTEGER micro-USD for all price/cost columns (prices as micro-USD-per-million-tokens); per-call breakdown + raw usage as JSON columns on `LoggedCallDB`; `unit` column dropped; time-windowing column slots left on model, placement deferred to ticket 04.
- [03 — Provider usage normalization](tickets/03-provider-usage-normalization.md) — backend is the single normalizer (langfuse model; apo's SDK becomes lossless data plumbing); provider detection is a multi-signal hierarchy (`providerMetadata` key-membership → `gen_ai.system` → model-name prefix → generic fallback); v1 ships per-provider normalizers for OpenAI + Anthropic + Bedrock + Gemini + generic resolver; non-overlap invariant (cache/reasoning subtracted from input/output) enforced uniformly across all providers, matching the OTel GenAI semconv; new `services/usage_normalization/` module replaces `extract_tokens`, callable from both the projector and the legacy direct-writer; unknown provider/key = store-but-unpriced (ticket 01 decision 3 enacted at the normalizer boundary).
- [04 — Conditional pricing: time-windowing](tickets/04-conditional-pricing-time-windowing.md) — window lives on the `models` row (one row per price era, same `match_pattern`); half-open `[start, end)` with `NULL` end = open-ended; overlapping windows for the same `(model, project)` rejected at write time (one-era-active invariant); apo's ingestion query must add the temporal predicate langfuse lacks (`[start,end) ∋ call.start_time`, with `start_date IS NULL` for legacy seed rows) so late-arriving spans price at the era in effect when the call happened; window key is `call.start_time`, fallback to ingestion-time + visible flag when absent; retroactive window edits never touch frozen calls — re-pricing (ticket 12) is the sole retroactive path, re-applying current windows+tiers against `start_time`+`raw_usage`; resolution order is model-era → tier → prices (tier conditions are usage-only, never time; default tier is fallback), handing ticket 05 a resolved contract.
- [05 — Conditional pricing: tier condition engine](tickets/05-conditional-pricing-tier-engine.md) — threshold-only engine, langfuse-minimal: a condition is `{keys: [canonical_key,…], operator ∈ {gt,lt,gte,lte}, threshold}`, match = sum of named canonical keys vs threshold; `eq`/`neq` and the arbitrary-regex-sum matcher dropped (langfuse uses none of them across 156 tiered models); condition sums a *set* of keys so the large-context tier correctly sums the read-side family `input + cache_read` (cached tokens occupy the context window); matching is langfuse's algorithm (non-default tiers by ascending priority, first-all-pass wins, else default tier); validation = exactly one default tier per model + same usage_key set across all tiers (regex safety N/A, no regex engine); batch/service-tier string-attribute conditions graduate to fog (apo's SDK doesn't capture `service_tier` today).
- [06 — Cost computation precedence & per-call storage](tickets/06-cost-computation-and-storage.md) — precedence is provided-wins-verbatim-else-compute (langfuse): SDK cost (breakdown map → frozen verbatim, total = sum; or scalar → frozen total, breakdown null) skips calculation; else compute `breakdown[k] = tier_prices[k] × raw_usage[k]` over keys in both, round-per-dimension to micro-USD int, total = sum; stored per call = frozen `cost` total + `cost_breakdown` JSON + `raw_usage` JSON + matched `model_id`/`tier_id`/`tier_name` + `provided_cost` + provenance flag; apo's three-field `cost→calculated→provided` precedence collapses (single effective total = always sum of breakdown or provided); compute once at ingestion (`_apply_cost`), then frozen; no-match ⇒ cost/breakdown null but `raw_usage` still stored; missing price for a present key ⇒ skip (impossible at tier level post-05, only for unpriced canonical keys).
- [07 — JSON defaults: format & loading](tickets/07-json-defaults-format-and-loading.md) — JSON is the sole source of truth for `__global__`, re-applied idempotently every startup (langfuse-aligned): globals absent from the file are deleted, edited globals reverted; user customization is per-project only, so the global-write API path (ticket 10) must reject global targets and point to per-project overrides; malformed bundled file fails hard (crashes startup, not silent partial load); units are per-1M USD human-readable (`2.50`), converted to micro-USD-per-million at load (02 #3); entry shape is apo-minimal — array of models with `pricingTiers[]`, price keys are 01's 6 canonical keys (not langfuse's freeform set), tier `conditions` use 05's `{keys,operator,threshold}` shape; loader replaces `seed_default_models` in `init_db`; idempotency is per-model `updatedAt` exact-equality vs DB (pinned from JSON, not `now()`), with the bump-discipline footgun handed to ticket 08.
- [09 — Migration from the current cost system](tickets/09-migration-from-current-system.md) — big-bang cutover (one release, no dual-write/flag; apo is pre-1.0 self-hosted and `calculated_cost`/`model_definitions` have no external consumers); existing `model_definitions` rows **dropped** (JSON loader from ticket 07 seeds the new 3-table shape fresh — migrating stale seed rows forward would collide with the loader and user overrides can't be cleanly distinguished from seeds without a heuristic that risks silent loss); `cost` column kept as effective-total (name unchanged so all aggregations survive) but type migrates float-USD → INTEGER micro-USD via `round(v×1e6)` on existing rows; `calculated_cost` dropped (replaced by ticket 06's provenance flag); historical calls stay scalar-only (`cost_breakdown`/`raw_usage` = null) because apo stores no raw usage today — no usage map to re-price against, so the re-pricing tool (ticket 12) only works post-migration.
- [12 — Re-pricing tool](tickets/12-repricing-tool.md) — overwrite-in-place (no parallel "re-priced" column — that would re-create the `cost`/`calculated_cost` split ticket 06 collapsed; `raw_usage` is immutable source and cost is its pure derivative, so overwriting derived cost isn't destructive to source data); `--dry-run` is the non-destructive preview path; **CLI-only trigger** (`apo reprice`, no API endpoint / dashboard button in v1 — re-pricing is a deliberate history rewrite, not a click; CLI calls a backend `services/reprice.py` fn mirroring `reproject.py`, *not* over HTTP); scope = AND-combined `--project`/`--model`/`--since`/`--until` (all optional; `--model` targets `internal_model_id`, the model the call was priced against); **inline streamed-batch with progress**, no background job (apo has no job framework; pure read-recompute-write, no span replay — resumable via idempotency); recomputes via the *same* ingestion compute fn over `raw_usage` + current tiers (ticket 04/05 resolution order); **provided-cost calls skipped** (SDK cost is authoritative); pre-migration calls without `raw_usage` skipped + reported; spec should recompute affected run/session rollups so totals stay coherent; resolves the CLI-surface fog for the re-pricing piece (the command *is* the surface).
- [10 — API surface](tickets/10-api-surface.md) — **nested document CRUD**: one `POST /api/v1/models` carries model + `pricingTiers[]` + prices in one transaction (validity is graph-level per tickets 04/05 — per-table endpoints would accept invalid intermediate states); `PUT/{id}` replaces the tier/price graph; reads return nested shape; same shape as ticket 07's JSON entries (API call = seed entry, verbatim); `POST /seed-defaults` **removed** (loader is the sole seed path); **writes reject `__global__`** (409 → directs to per-project overrides — ticket 07's "JSON is sole truth for globals" makes a writable global path fight the loader), reads of globals still allowed; `GET /models/match` **upgraded to full usage map** (canonical-key→tokens + optional `start_time`) returning the same breakdown ingestion freezes (ticket 06) — reuses the model-era→tier→price→compute pipeline, shared with re-pricing (ticket 12); **no separate preview endpoint** (match endpoint is the preview); **anchored full-match canonicalized server-side** (`re.fullmatch(..., re.IGNORECASE)`, langfuse's `(?i)^…$`) — kills the client/server regex mismatch at the source, dashboard's `model-pricing.ts` removed by ticket 11; in-place on `/v1` (pre-1.0, no external consumers — matches ticket 09 big-bang).
- [11 — Dashboard cost display](tickets/11-dashboard-display.md) — prototype at `prototypes/cost-display-prototype.html` (throwaway, open in browser, uses exact OKLCH tokens + inverted tooltip surface); tooltip **groups by family** (Input: input/cache_read/cache_write_5m/cache_write_1h · Output: output/reasoning), **sorts by magnitude, hides zero-cost rows**, total above the rule (scales 1→6 dims without a layout jump); **provenance is a quiet footer** (`computed`/`provided by SDK`), not the old "Provided:$X · Calculated:$Y" parallel row — ticket 06 collapsed that split, the tooltip honors it (the `costsDiffer` divergence logic deleted); **`model-pricing.ts` deleted in full** (fetchModelPricing/matchModelPricing/computeCallBreakdown/computeRunBreakdown — dashboard reads stored `cost_breakdown` directly; kills the regex-anchoring mismatch + stale-price recompute + per-call pricing fetch); **unpriced dimensions surface in `--warning` amber** (makes mispriced models debuggable — locked decision 3's purpose); **legacy calls show "no breakdown stored"** (no synthesis from current prices — ticket 04 time-windowing makes that misleading); **dimension identity = monochrome shades, never hue** (design.md: "color = state, not decoration"; a dimension is identity — six grayscale steps, amber reserved for the one state transition: unpriced); run/session rollup gains a 3px monochrome **dimension mix bar** per model, list views stay scalar; cost formatting consolidated to one `usdFormat` (≥1→2dp, ≥0.01→4dp, else 6dp).
- [08 — JSON defaults: maintenance workflow](tickets/08-json-maintenance-workflow.md) — on-demand PRs (langfuse's cadence) **plus** a staleness signal langfuse lacks, because no one's full-time job is pricing at apo's size; the signal is a per-model `last_reviewed: "YYYY-MM"` field in the bundled JSON + a CI age check (~4mo, warning not hard-fail) catching **stale prices**, while **missing models** are caught at runtime by ticket 11's per-dimension amber — the two failure modes are deliberately split across maintainer-facing and runtime layers; `last_reviewed` is **JSON-only, never the DB** — keeps ticket 07's `updatedAt`-exact-equality idempotency gate untouched (a review-only bump changes `updatedAt` by nothing → loader skips the write), and is maintainer-facing only (no dashboard/CLI surface, consistent with ticket 11 leaving "stale window" indicators post-v1); review gate is a CI validation script enforcing ticket 05's rules + JSON Schema, run on every PR touching the file (no PR template — the script is the hard gate); sourcing is hand-written from the provider's pricing page with LiteLLM as a cross-check *reference only*, never imported or CI-diffed (decouples from third-party correctness/licensing); ownership is "whoever ships a release," documented in the file header + self-hosting docs and passively enforced by the CI nag.
- [13 — Testing strategy](tickets/13-testing-strategy.md) — **parametrized fixtures over generated inputs** (apo has zero property-testing infra — no hypothesis/fast-check anywhere; introducing a new dependency+discipline for a pre-1.0 corpus of documented provider shapes is the wrong trade — hand-picked boundary cases via `@pytest.mark.parametrize` cover the invariants the ticket body wanted property tests for); per-component targets: normalization/tier-matching/time-windowing/cost-compute/match-endpoint each get a unit test file; **normalization fixture corpus hand-built from provider docs** at `fixtures/usage/` in the established `{description,source,input,expected}` shape (mirroring the OTel corpus), non-overlap invariant asserted in every fixture's `expected`; **golden-model pricing corpus of 4 models** (flat / large-context-tiered / cache-tiered / reasoning — one per pricing *shape*, not per popularity) hand-verified, reused across tier-match+compute+reprice+match tests; **rounding covered by explicit edge fixtures** (not a generator — `int = sum(ints)` only fails if rounding direction is wrong); **integration seam is `_apply_cost` via the projector** — extend the existing `test_trace_projector.py` (agent found it doesn't assert cost today) + `test_ingestion_canonical_adapter.py` to assert the full frozen field set, parametrized over the 4 golden models × 2 write paths; migration tests follow the established hand-rolled old-schema SQLite pattern (`test_metric_project_migration.py`); frontend tests are local guardrails (CI doesn't run vitest) — proportionate coverage on layout logic only; CI gate stays `uv run pytest -x -q` (backend-only).

## Not yet specified

<!-- fog: in-scope but can't yet be phrased as a sharp ticket -->

- **Batch / service-tier pricing.** Threshold-only engine (ticket 05) can't
  express attribute-based tiers (`service_tier == "batch"`, priority
  dispatch). apo's SDK doesn't capture `service_tier` today, so the
  condition is unreachable even if the engine supported it. Graduates into a
  ticket when (a) a provider apo ingests bills a string-attribute tier AND
  (b) apo's ingestion captures that attribute. Until then it's not
  specifiable.

- **Caching strategy.** langfuse layers an in-process LRU on Redis for model
  resolution (runs on every observation). apo is single-binary SQLite — unclear
  whether model resolution needs caching at all, or whether it's cheap enough
  to do per-call. Decide after the data model and compute pipeline tickets
  reveal the query pattern.

- **CLI surface.** Resolved by tickets 10 + 12: `apo reprice` is the one new
  command (CLI-only, ticket 12); no separate CLI pricing-edit command in v1 —
  globals are JSON-authored (ticket 08), per-project overrides use the API
  (ticket 10), and a `models edit` CLI command would only be a convenience
  wrapper over `PUT`, not a correctness need. Other CLI cost-display commands
  (`runs`/`traces`) read stored breakdowns; no new commands required for the
  cost system to be correct.

- **Re-pricing `--include-provided` escape hatch.** Ticket 12 skips
  provided-cost calls by default (the SDK's cost is authoritative). Whether to
  ship a `--include-provided` flag that force-reprices even provided calls (e.g.
  when the provider's own number was wrong) is now specifiable as a small
  follow-up — low priority, defaults to "no flag."

## Out of scope

<!-- work ruled beyond the destination -->

- **Remote/runtime pricing-feed fetching.** Decided against (locked decision 4)
  — defaults ship in the release. If users later want a feed, that's a future
  effort (per-project override or an "import from URL" tool), not this map.
- **Real-time cost budgets / alerting.** That's a product feature built on top
  of a working cost system, not part of making the cost system correct. Future
  effort.
- **Cost projection / forecasting.** Same — downstream product feature.
- **Tokenization fallback.** langfuse can tokenize input/output itself when the
  SDK doesn't send usage. apo's SDKs send usage; adding a tokenizer is a
  separate concern and not needed for the cost system to be correct.
