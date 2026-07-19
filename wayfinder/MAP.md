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

- **CLI surface.** apo's CLI (`packages/cli`) displays cost in several commands.
  Whether the CLI needs new commands (e.g. a re-price command, a pricing-edit
  command) depends on the re-pricing tool and API surface decisions.

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
