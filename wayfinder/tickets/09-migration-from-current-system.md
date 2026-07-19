# 09 — Migration from the current cost system

**Type**: Grilling (HITL) · **Status**: closed · **Claimed by**: cost-session-09 · **Blocked by**: 02, 06

## Question

What happens to existing apo installations when the new cost system lands? Which
existing data migrates, which is backfilled, which is left as-is, and what's the
cutover?

### Context

Existing things that would change or go away:
- `backend/apo/models/pricing.py` `ModelDefinitionDB` — single table, three
  price columns (`input_price`/`output_price`/`cached_input_price`). Replaced by
  the new data model (ticket 02).
- `backend/apo/services/cost_calculation.py` `DEFAULT_MODELS` — the Python
  literal seed. Replaced by JSON defaults (ticket 07).
- `LoggedCallDB` fields `cost` / `provided_cost` / `calculated_cost` /
  `prompt_tokens` / `completion_tokens` / `total_tokens`. Some kept, some moved,
  breakdown/usage added (ticket 06).
- `seed_default_models` (`db.py:170`) — replaced by the new JSON loader.
- Aggregation that sums `cost` across calls/runs/sessions
  (`trace_backend.aggregate_costs`, `metrics/aggregate.py`,
  `routes/runs/metrics.py`, `routes/runs/sessions.py`). Must keep working
  through the migration.

### To decide

- **Existing `model_definitions` rows**: migrate forward (translate each old row
  into the new tier/price shape — straightforward: input_price → `input` price,
  output_price → `output` price, cached_input_price → `cache_read` if non-null),
  or drop and let users re-enter via the API/JSON? Migrate-forward is friendlier;
  drop is simpler.
- **Existing `LoggedCallDB` cost fields**: keep the scalar `cost` as the
  effective total (preserves existing dashboard/aggregation queries), add the
  new breakdown/usage storage alongside. Or rename/restructure and rewrite the
  aggregations? Keeping the scalar `cost` as the source of truth for "total"
  minimizes blast radius.
- **Backfill historical breakdowns**: old calls have no per-dimension breakdown
  (only scalars). Do we (a) leave them as scalar-only (breakdown shows "legacy
  call, no breakdown"), (b) synthesize a synthetic breakdown from the stored
  tokens + the *current* price (misleading — wrong window), or (c) run the
  re-pricing tool (ticket 12) over history to populate breakdowns where a
  matching model + price exist? (c) is correct but only works where old usage
  can be reconstructed; apo doesn't store raw usage maps today, so old calls
  likely can't get true breakdowns — confirm.
- **Cutover**: big-bang (one release, old code removed) vs phased (new system
  runs alongside old, dual-write, flip a flag). apo is pre-1.0 and self-hosted
  with likely few installations — big-bang is probably fine, confirm.
- **`provided_cost` semantics**: apo's three-field precedence (ticket 06) may
  collapse to langfuse's "provided wins." What happens to existing rows where
  `provided_cost` was set but `cost` was computed? Decide as part of ticket 06,
  applied here.

### Scope

Decides the migration shape (forward-migrate vs drop, backfill policy, cutover).
The *specific SQL* is implementation detail in the spec.

---

## Resolution

**Resolved 2026-07-22.** Two real decisions (cutover, model-rows) settled by
grilling; the ticket's other three bullets were already closed by the blocking
tickets (02, 06) — recorded as confirmed below so the spec writer has the full
migration contract in one place.

### 1. Cutover — big-bang, one release (the decision)

One release lands the new schema and a one-shot startup migration. The old
`model_definitions` table and the `calculated_cost` column are dropped in the
same release. No dual-write, no flag, no compatibility window.

Justification grounded in the codebase and the destination:
- apo is **pre-1.0** (`backend/pyproject.toml` v0.2.0), self-hosted,
  single-binary SQLite, likely few installations — the silent-break risk that
  would justify phased rollout isn't present.
- The only thing that *could* justify phased is an external consumer of the
  dropped fields. Zoom-in confirmed there isn't one: `calculated_cost` is read
  only inside apo's own three-field fallback
  (`trace_backend.py:124-135`), which ticket 06 removes; `model_definitions`
  is read only by `cost_calculation.py` + `routes/models.py`, both replaced.
- Phased would mean building dual-write scaffolding (write both old and new on
  every ingestion path) that gets deleted in the follow-up release — pure
  throwaway for a pre-1.0 install base.

### 2. Existing `model_definitions` rows — drop, JSON loader seeds fresh (the decision)

The old `model_definitions` table is dropped on migration; no rows are
translated forward. Ticket 07's JSON-defaults loader (`seed_default_models`
replacement) upserts the current default-model set into the new 3-table shape
on the same startup. Users re-enter any per-project overrides via the API.

Why drop beats migrate-forward (the finding that drove the decision):
- The old table holds **two things mixed**: stale seed rows from `DEFAULT_MODELS`
  (the module docstring admits staleness — "no Claude 3.7/4, partial GPT-4.1,
  no 2026 releases") and genuine user overrides. There's **no `is_seed` flag**
  to tell them apart.
- Migrate-forward-everything (option B) collides with the JSON loader: both
  touch the same `match_pattern` rows on startup, so order + reconciliation
  logic has to be correct on a one-shot migration. Extra moving parts for rows
  that are about to be overwritten anyway.
- Migrate-forward-overrides-only (option A) needs a seed-detection heuristic
  (match against `DEFAULT_MODELS`), whose failure mode is **silently dropping a
  legitimate override** that shadows a seed model — exactly the quiet data loss
  a migration shouldn't risk.
- Pre-1.0 + few self-hosted installations + a stale seed being replaced means
  the re-entry cost of dropping is small (minutes if anyone had overrides at
  all), while drop sidesteps the collision-with-loader problem entirely.

### 3. Existing `LoggedCallDB` cost fields — confirmed from ticket 06 (not a new decision)

Ticket 06's hand-off already settled this; recorded here so the migration
contract is complete:

- **`cost` column kept, meaning unchanged ("effective total")** — preserves
  every existing aggregation query (`trace_backend.aggregate_costs`,
  `metrics/aggregate.py`, `runs/metrics.py` all read the scalar `cost`).
  Minimal blast radius.
- **Type changes float USD → INTEGER micro-USD** (ticket 02 decision 3) — so
  migrating existing `cost` (and `provided_cost`) values is a *data transform*
  (`round(value × 1_000_000)`), not a schema add. Applied to existing rows in
  the same startup migration.
- **`calculated_cost` dropped** — replaced by the provenance flag
  (`provided`/`computed`) from ticket 06. The column is removed; no backfill
  (the flag is set per-row at compute time going forward).
- **Existing rows where `provided_cost` was set but `cost` was computed**: keep
  `cost` as the frozen total (that's what was displayed); provenance backfills
  as `computed`. (Ticket 06 hand-off, verbatim.)

### 4. Backfill historical breakdowns — leave old calls scalar-only (not a new decision)

Ticket 06 failure-mode 1 says no-match ⇒ `cost`/`cost_breakdown` null but
`raw_usage` still stored. That's the forward contract. For *historical* calls,
zoom-in on the current schema confirmed apo stores **no raw usage today**: only
scalar `prompt_tokens` / `completion_tokens` / `total_tokens`; the
`cached_tokens` that `calculate_cost` consumes is used at compute time and
never persisted, and there is no `raw_usage` / usage-details column.

**Implication:** old calls have nothing to re-price against — backfill option
(c) from the ticket body (run the re-pricing tool over history) is impossible
for everything already ingested. Option (b) (synthesize breakdown from current
price) is rejected as misleading (wrong time-window per ticket 04). So:
- **Pre-migration calls:** `cost_breakdown = null`, `raw_usage = null`, scalar
  `cost` carried forward as micro-USD. The dashboard (ticket 11) renders "no
  breakdown for this call" for them.
- **Post-migration calls:** full per-dimension breakdown + raw usage stored per
  ticket 06. Re-pricing (ticket 12) works from this point on.

This is the unavoidable seam: the cost system is correct from the migration
forward; history keeps its scalar totals and gains no breakdown.

### What the migration does, in order (the *what*, not the *how*)

1. Create the new tables (`models`, `pricing_tiers`, `prices`) per ticket 02.
2. Add new `LoggedCallDB` columns: `cost_breakdown` (JSON), `raw_usage` (JSON),
   provenance flag, matched `tier_id` / `tier_name`.
3. Transform existing `cost` and `provided_cost` on `logged_calls`:
   float-USD → INTEGER micro-USD (`round(v × 1_000_000)`).
4. Drop `calculated_cost` column from `logged_calls`.
5. Drop the old `model_definitions` table entirely.
6. Run the JSON-defaults loader (ticket 07) to seed the new tables.

Specific SQL, cutover ordering, and SQLite `ALTER TABLE` mechanics are
implementation detail in the spec.

### Out of scope for this ticket

- Specific migration SQL / `ALTER TABLE` mechanics / cutover ordering (spec).
- JSON defaults content (ticket 07).
- Re-pricing of post-migration calls (ticket 12).
- Dashboard rendering of "no breakdown" legacy calls (ticket 11).

