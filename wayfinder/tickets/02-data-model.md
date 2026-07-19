# 02 — Cost data model (SQLModel/SQLite)

**Type**: Grilling (HITL) · **Status**: closed · **Claimed by**: ZCode (cost session) · **Blocked by**: 01

## Question

What is the SQLModel/SQLite data model for pricing and stored cost?

This decides the tables that hold the `(model, usage_key) → price` data, the
conditional-pricing structures that sit on top, and what gets stored on each
logged call (per the locked decision: frozen cost + per-dimension breakdown +
raw normalized usage).

### Context (from research)

langfuse uses three tables — `Model` → `PricingTier` → `Price` — in Prisma over
Postgres with `DECIMAL(65,30)` precision. apo is SQLModel over SQLite, single
binary, no Postgres/ClickHouse split. The current apo shape
(`backend/apo/models/pricing.py`) is one table `ModelDefinitionDB` with
`input_price` / `output_price` / `cached_input_price` columns — which fails the
open-enum test (a new billable dimension needs a schema change).

Per-call storage today (`backend/apo/models/db.py` `LoggedCallDB`) carries
`cost`, `provided_cost`, `calculated_cost` (three scalars) plus
`prompt_tokens` / `completion_tokens` / `total_tokens`. No per-dimension
breakdown, no raw usage map.

### To decide

- **Pricing tables**: 3-table `models → pricing_tiers → prices` shape (langfuse)
  vs a flatter shape that still satisfies "open usage_key enum" (e.g. one
  `model_prices` table with `(model_id, tier_id, usage_key, price)` rows). The
  tier table only earns its place if conditional pricing needs it (ticket 05).
- **Precision**: SQLite `REAL` (float) vs storing price as integer
  micro-USD vs TEXT-encoded Decimal. Float rounding across millions of calls is
  a real correctness question; langfuse picked `DECIMAL(65,30)` for a reason.
  What's the right SQLite answer?
- **Per-call storage**: where does the per-dimension breakdown live? A separate
  `call_cost_breakdown` table keyed by `(call_id, usage_key)`, or a JSON column
  on `LoggedCallDB`? Same question for the raw normalized usage map. Trade-off:
  queryability (table) vs simplicity/SQLite-friendliness (JSON column).
- **Project scoping**: keep apo's current `project` / `__global__` override
  pattern? (langfuse does, with `projectId IS NULL` for globals.)
- **Time-windowing columns**: `start_date` / `end_date` placement — on model, on
  tier, or both? (Coupled to ticket 04; decide together or split.)

### Scope

Decides table shapes, columns, types, and relationships. Does *not* decide the
SQL migrations (that's implementation detail in the spec) or the exact enum
members (ticket 01).

---

## Resolution

**Resolved 2026-07-20.** Seven decisions, closing every open question above:

1. **Pricing-table shape — langfuse's 3-table, adapted.** Adopt
   `models → pricing_tiers → prices`, with `prices` keyed
   `(model_id, usage_key, tier_id) → price`. This is the open-enum answer: a
   new billable dimension is a new row in `prices` with a new `usage_key`,
   *not* a schema change — directly fixing the failure mode of today's
   `ModelDefinitionDB` (`input_price` / `output_price` / `cached_input_price`
   columns). Carrying `pricing_tiers` now (rather than flattening + JSON for
   tiers) is justified because the locked decisions already commit to tier
   pricing — flattening now would mean migrating twice when ticket 05 wires
   the engine in. Tier *conditions* (the matching rules) are a JSON column on
   the tier; tier *prices* are rows in `prices` (the price lookup that runs on
   every ingested call needs to be indexable, not JSON-scanned).

2. **`unit` column — dropped.** Every canonical key from ticket 01 is
   token-denominated. If a non-token dimension (per-image, per-request) ever
   joins the enum, a one-column migration adds `unit` — not architecturally
   wrong to defer, YAGNI applies. Flagged here so it's visible.

3. **Precision — INTEGER micro-USD for all price and cost columns.** Native
   SQLite, indexable, SQL `SUM` is exact, no float drift across millions of
   rows. Convention:
   - **Prices** stored as micro-USD *per million tokens*. `$2.50/MTok` →
     `2_500_000`. The JSON defaults (ticket 07) stay human-readable (`2.50`),
     converted at load.
   - **Per-call cost** stored as micro-USD integer. Worst case
     (10M tokens × $1000/MTok) ≈ 1e16, far under the 64-bit ceiling (9.2e18).
   - **Breakdown reconciliation**: each dimension's micro-USD rounded
     independently; total = sum of breakdown rows. Reconciles exactly.
   - **Display layer** (dashboard, CLI) divides by 1e6 for USD.
   Float-on-money is the textbook landmine the locked "architectural
   correctness over effort" preference rules out; Decimal-as-TEXT makes the
   primary access pattern (SUM aggregates for run/project totals) ugly or
   lossy. The exact rounding rule (round-per-dimension vs sum-then-round) is
   a compute-pipeline decision deferred to ticket 06 — this ticket only
   picks the type.

4. **Per-dimension breakdown storage — JSON column on `LoggedCallDB`.** New
   column `cost_breakdown: dict[str, int] | None` (JSON), keyed by canonical
   usage key (`input`, `cache_read`, `cache_write_5m`, `cache_write_1h`,
   `output`, `reasoning`) → micro-USD. Access-pattern fit: breakdown is read
   on the *call detail* view, not aggregated across calls; aggregations
   (run totals, project charts) operate on the frozen scalar `cost`, which
   the locked decisions keep. apo already uses JSON columns liberally (32
   instances: `tags`, `tool_parameters`, `tool_result`, `meta`); a separate
   table for a 6-key map would be the odd one out. If a cross-call
   per-dimension analytic ever becomes hot, apo's existing projection-table
   pattern (`trace_projection.py`, ADR-0002/0003) is the right place —
   defer until measured.

5. **Raw normalized usage storage — JSON column on `LoggedCallDB`.** New
   column `raw_usage: dict[str, int] | None` (JSON), strict superset of the
   priced keys: canonical keys carry their token counts, unknown keys kept
   store-but-unpriced (per ticket 01 decision 3) under their original
   post-normalizer name. This is what makes re-pricing (ticket 12) always
   possible — re-pricing reads `raw_usage` + the (possibly updated) price
   table, recomputes, writes back. No joins.

6. **Project scoping — keep apo's `"__global__"` sentinel.** Locked decision
   4 already settles that per-project overrides come via the API/DB; the
   only open detail was `__global__`-sentinel vs langfuse's `projectId IS
   NULL`. Keep the established apo convention — minimal churn, the choice is
   cosmetic, and not worth a migration.

7. **Time-windowing column slots — leave them, defer placement.** This
   ticket puts nullable `start_date` / `end_date` UTC-datetime column *slots*
   on the model (uncontroversial — nullable datetimes). Where time-windowing
   *lives* (on the model, on the tier, or both) is ticket 04's decision and
   wires them accordingly. Keeps each ticket sharp; this ticket doesn't
   pre-decide 04.

### Out of scope for this ticket

- `unit` column (deferred; see decision 2).
- The exact cost rounding rule (deferred to ticket 06).
- Exact migration SQL / cutover plan (spec/impl detail; ticket 09 owns the
  *what* of migration, the *how* follows the spec).
- Time-windowing column placement (ticket 04).
- Whether to add a per-dimension projection table for cross-call analytics
  (defer until a measured need; use the existing projection pattern).
