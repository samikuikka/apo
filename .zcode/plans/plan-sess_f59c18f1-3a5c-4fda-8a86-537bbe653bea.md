# SPEC-136 Cost System Redesign — TDD Implementation Plan

## Resolved decisions (before coding)

1. **Reprice transport = HTTP endpoint + poll** (you said "choose what's best"). `reprice_calls()` stays a pure Python DB-level callable in `services/reprice.py` (directly unit-testable, mirroring `reproject.py`). A thin FastAPI route `POST /v1/admin/reprice` (admin-scoped, like the retention endpoints — re-pricing is a history rewrite) wraps it. The CLI command (`commands/reprice.ts`) kicks off the job, then polls `GET /v1/admin/reprice/{job_id}` every 2s for status, printing progress — exactly the proven `task-run.ts:226-255` pattern that already solves "long CLI op under the 15s timeout." The job state lives in a small in-memory dict on the backend (re-price is an operator action; if the process dies mid-run, re-running is idempotent per the spec).

2. **Price units (spec has a contradiction).** Tickets 02/06/07 agree: DB stores **micro-USD per 1M tokens** (= USD-per-1M × 1e6; e.g. $2.50/1M → `2_500_000`), and `cost_micro = round(price_stored × tokens / 1_000_000)` per dimension. Ticket 02's int64 bound ("≈1e16 for the un-divided product") confirms the `/1e6`. The ticket-10 API example (`"input": 3000`) is the lone outlier — it's a typo (should be `3_000_000` for $3/1M, or `3.0` if the wire unit is USD-per-1M). I'll honor **"API call = seed entry verbatim"** (ticket 10) + **"JSON is human-readable USD-per-1M"** (ticket 07): both the JSON file and `ModelDocumentCreate` use **USD-per-1M as a number** (e.g. `3.0`); the loader and the create/replace routes convert × 1e6 to micro-USD-per-1M for the `prices.price_per_1m` column. `MatchResponse` returns `cost_breakdown` in micro-USD int (same as stored on the call).

## TDD ordering (tests-first per layer; each phase is RED → GREEN)

Dependency order means lower layers are built/tested first and never re-imported by upper layers. Every backend test file starts with the pyright-suppression header (`# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false`).

### Phase 1 — Canonical usage keys (ticket 01)
- **Create** `backend/apo/models/usage_keys.py`: `UsageKey(str, Enum)` (6 values), `INPUT_FAMILY`, `OUTPUT_FAMILY` frozensets — verbatim from spec lines 84-99.
- *No tests needed for a pure enum; covered transitively.*

### Phase 2 — Data model + schemas (ticket 02, 06)  ← tests-first
- **Write** `backend/tests/test_pricing_models.py` (RED): assert the 3 tables exist post-`create_all`, `TierCondition` validates operators, `ModelDocumentCreate`/`MatchResponse`/`ModelDocument` shapes parse.
- **Rewrite** `backend/apo/models/pricing.py` entirely: drop `ModelDefinitionDB` + flat schemas; add `ModelRowDB`, `PricingTierDB`, `PriceDB` (table=True) + `TierCondition`, `ModelDocumentCreate`, `ModelDocument`, `MatchResponse` (SQLModel, not table).
- **Modify** `backend/apo/models/schemas.py` `LoggedCallBase`: `cost`/`provided_cost` `float→int` (micro-USD); **drop** `calculated_cost`; add `cost_breakdown: dict[str,int]|None`, `raw_usage: dict[str,int]|None`, `internal_model_id` (already exists, add FK), `matched_tier_id`, `matched_tier_name`, `cost_provenance: "provided"|"computed"|None`.
- **Modify** `backend/apo/models/db.py` `LoggedCallDB`: map `cost_breakdown`/`raw_usage` to JSON columns (mirror existing `meta`→`metadata` pattern at db.py:315).

### Phase 3 — Migration (ticket 09)  ← tests-first
- **Write** `backend/tests/test_cost_migration.py` (RED): fresh `create_engine("sqlite://")`, hand-build old schema (`model_definitions` + `logged_calls` with float costs + `calculated_cost`) via `exec_driver_sql`/`text()` (mirror `test_projection_identity_migration.py`), insert legacy rows, call migration, assert: costs now micro-USD int (`round(v×1e6)`), `calculated_cost` gone, new columns present, `model_definitions` dropped, new 3 tables created.
- **Modify** `backend/apo/db.py`: add `_migrate_to_v10()` (the cost migration) to `_SCHEMA_MIGRATIONS`, bump `LATEST_SCHEMA_VERSION=10`. Reuse existing helpers `_add_column_if_missing`, `_drop_column_if_exists`, `_create_index_if_not_exists`. The float→int transform uses `UPDATE ... SET cost = ROUND(cost * 1000000)` (SQLite `ROUND` returns float; cast to int via the column affinity — verify with a guarded backfill). `calculated_cost` drop via `_drop_column_if_exists`.

### Phase 4 — Usage normalization (ticket 03)  ← tests-first
- **Write** `backend/tests/fixtures/usage/*.json` (~12 fixtures in `{description, source, input, expected}` shape: OpenAI/Anthropic/Bedrock/Gemini/generic × cached/reasoning/plain). Non-overlap invariant asserted in every `expected`.
- **Write** `backend/tests/test_usage_normalization.py` (RED): parametrize over fixtures; assert `normalize_usage(input, provider) == expected` and the non-overlap invariant (cache/reasoning subtracted).
- **Create** `backend/apo/services/usage_normalization/` package: `__init__.py` (detect_provider hierarchy + dispatch), `openai.py`, `anthropic.py`, `bedrock.py`, `gemini.py`, `generic.py` — each `normalize(attributes) -> dict[str,int]`. Provider detection: `ai.response.providerMetadata` key-membership → `gen_ai.system` → model-name prefix → generic. Non-overlap applied uniformly. Based on `wayfinder/assets/03-normalizer-research.md` mappings.

### Phase 5 — Pricing resolution + compute + validation (tickets 04, 05, 06)  ← tests-first
- **Write** `backend/tests/test_time_windowing.py` (RED): era selection `[start,end)`, `start_date IS NULL` legacy match, late-arriving span, one-era-active.
- **Write** `backend/tests/test_tier_matching.py` (RED): golden Gemini-2.5-Pro large-context model; `input+cache_read` sum crosses 200k threshold; default fallback; priority order.
- **Write** `backend/tests/test_cost_compute.py` (RED): 4 golden models (flat/large-context/cache-tiered/reasoning); `breakdown[k]=round(price×tokens/1e6)`; `total=sum(breakdown)`; reconciliation fixture; unpriced-key skip; no-match→all-None.
- **Create** `backend/apo/services/pricing/validation.py`: validate `TierCondition` operators; exactly-one-default; same usage_key set across tiers; non-overlapping eras. Raises `ValueError` with detail for 422s.
- **Create** `backend/apo/services/pricing/resolution.py`: `resolve_model_era(session, model_name, project, at_time)` (fullmatch + temporal predicate, project-shadows-global), `match_tier(model, usage)` (priority-ascending, first-all-pass, else default).
- **Create** `backend/apo/services/pricing/compute.py`: `compute_cost(...)` → `ComputedCost(model_id, tier_id, tier_name, breakdown, total)`. Negative-clamp-to-0 + warn. No-match → all None.

### Phase 6 — JSON defaults loader + bundled JSON (ticket 07)
- **Write** `backend/tests/test_pricing_loader.py` (RED): load JSON, assert 3-table rows; idempotency (reload = no writes via `updated_at` equality); malformed JSON raises hard; globals-absent-from-file get deleted; per-project rows untouched.
- **Create** `backend/apo/data/default-model-prices.json`: array of model entries (port current `DEFAULT_MODELS` set + the 4 golden shapes) in ticket-07 shape (`matchPattern`, `provider`, `pricingTiers[]` with `conditions` + `prices` in USD-per-1M, `updatedAt`, `last_reviewed`).
- **Create** `backend/apo/services/pricing/loader.py`: `load_default_prices(session)` — full reconciliation toward JSON for `__global__` only; ×1e6 conversion; `updated_at`-exact-equality idempotency; fail-hard on malformed.
- **Modify** `backend/apo/db.py` `init_db`: replace `seed_default_models` call with `load_default_prices`.

### Phase 7 — Wire compute into ingestion (both paths) (ticket 06)  ← extend existing tests
- **Extend** `backend/tests/test_trace_projector.py` (RED): add cost assertions to a priced-model span — after `project()`, `LoggedCallDB` has `cost`, `cost_breakdown`, `raw_usage`, `matched_tier_id`, `cost_provenance="computed"`.
- **Extend** `backend/tests/test_ingestion_canonical_adapter.py` (RED): same frozen field set after `POST /api/v1/ingestion`.
- **Rewrite** `backend/apo/services/trace_projector.py::_apply_cost`: `normalize_usage(span.attributes, provider)` → `raw_usage`; if SDK provided cost → freeze verbatim (`provenance="provided"`, breakdown from SDK map or null); else `compute_cost(...)` → freeze (`provenance="computed"`). Still GENERATION-only.
- **Modify** `backend/apo/services/trace_projector.py::_upsert_call`: also persist `raw_usage` from the normalizer onto the call.
- **Modify** `backend/apo/services/ingestion.py`: `process_call_create`/`process_call_update` call `normalize_usage` + `compute_cost` (same pipeline).
- **Delete** `backend/apo/services/cost_calculation.py` and `backend/tests/test_cost_calculation.py` (functions gone; rewire any stragglers).

### Phase 8 — Models API rewrite (ticket 10)  ← tests-first
- **Write** `backend/tests/test_models_api.py` (RED): nested CRUD (list/get/create/put/delete), `__global__` write→409, tier validation→422, `?effective=true` merge.
- **Write** `backend/tests/test_models_match.py` (RED): `GET /api/v1/models/match?model=&usage=&start_time=` → tier + breakdown; anchored fullmatch (`gpt-4o` ≠ `gpt-4o-mini`); era by start_time.
- **Rewrite** `backend/apo/routes/models.py`: nested-document CRUD + match endpoint; remove `/seed-defaults`; 409 on `__global__` writes; validation via `pricing/validation.py`.
- Confirm `backend/apo/routes/__init__.py` + `api.py` still register the models router (path `/api/v1/models` unchanged).

### Phase 9 — Reprice service + endpoint + CLI (ticket 12)  ← tests-first
- **Write** `backend/tests/test_reprice.py` (RED): computed calls repriced, provided skipped, pre-migration (no raw_usage) skipped+reported, no-match skipped+reported, dry-run commits nothing, idempotent, rollups refreshed.
- **Create** `backend/apo/services/reprice.py`: `reprice_calls(session, *, project, model_id, since, until, dry_run, batch_size) -> RepriceSummary` — inline streamed-batch, per-row try/except (mirror `reproject_trace`), reads raw_usage+current tiers, overwrites in place when not dry_run, then refreshes run/session rollups (`aggregate_costs`/`calculate_and_store_aggregate_metrics`).
- **Add** `POST /v1/admin/reprice` (kick-off) + `GET /v1/admin/reprice/{job_id}` (poll) to `backend/apo/routes/admin.py` (admin-scoped). In-memory job dict; background thread runs `reprice_calls`.
- **Create** `packages/cli/src/commands/reprice.ts`: parse `--project/--model/--since/--until/--dry-run`, kick off + poll (mirror `task-run.ts`), print summary, `--json` support.
- **Write** `packages/cli/tests/reprice.test.ts` (RED): mock `globalThis.fetch` (kick-off + poll responses), assert exit code + summary output.
- **Modify** `packages/cli/src/main.ts`: add `"reprice"` to the `commands` record with full `CommandEntry` (help/args/options/examples). Verify `node --experimental-strip-types packages/cli/src/main.ts reprice --help`.

### Phase 10 — Frontend: delete client-side pricing (ticket 11)  ← tests-first
- **Write** `apps/dashboard/src/components/trace-detail/__tests__/DimensionBreakdownTooltip.test.tsx` (RED): render stored `cost_breakdown` (6 dims, mixed families); hover → family groups, sorted by magnitude, zero hidden, unpriced amber, provenance footer, legacy footer; **no fetch**.
- **Delete** `apps/dashboard/src/lib/model-pricing.ts` + `apps/dashboard/src/lib/__tests__/model-pricing.test.ts`.
- **Create** `apps/dashboard/src/components/trace-detail/DimensionBreakdownTooltip.tsx` (rename+rewrite): reads stored `cost_breakdown`/`raw_usage`/`cost_provenance`; family groups, magnitude sort, zero-hide, unpriced amber (`--warning`), provenance footer, legacy footer. Monochrome shades per dimension (design.md).
- **Create** `apps/dashboard/src/components/trace-detail/DimensionMixBar.tsx`: 3px monochrome bar.
- **Modify** `apps/dashboard/src/components/trace-detail/TraceDataContext.tsx`: `LoggedCall` cost fields → `cost?: number|null` (now micro-USD), add `cost_breakdown`/`raw_usage`/`cost_provenance`, drop `calculated_cost`. Add `usdFormat` to `apps/dashboard/src/lib/format.ts` (≥1→2dp, ≥0.01→4dp, else 6dp; divides micro-USD by 1e6).
- **Modify** `apps/dashboard/src/app/project/[projectId]/traces/columns.tsx`: `UsageCell` — drop `pricingCache`/`fetchModelPricing`/inline recompute; read stored breakdown.
- **Modify** `apps/dashboard/src/components/trace-detail/TraceDetailTabs.tsx`: costs tab — `DimensionMixBar` per model, `usdFormat`.
- **Modify** `apps/dashboard/src/components/trace-detail/TraceDetailView.tsx`: cost pills → `usdFormat(call.cost)`, swap tooltip import.
- **Delete** old `CostBreakdownTooltip.tsx` + its test.

### Phase 11 — Verify & document
- Run gates: `pnpm lint`, `pnpm typecheck`, `cd backend && uv run basedpyright`, `cd backend && uv run pytest -x -q`, `pnpm --filter @apo/cli test`.
- Update `docs/architecture.md` (cost system section), `project/status.md` (check off SPEC-136).
- Grep confirms: `model-pricing.ts` gone, `cost_calculation.py` gone, no `calculated_cost` remains.

## Execution note
This is a large spec (~35 files). I'll execute phases 1–11 in order, committing per phase with descriptive jj messages. Tests are written RED before each layer's implementation. If context runs short mid-spec, the carry-forward summary preserves the dependency map and the unit decisions above so work resumes cleanly.