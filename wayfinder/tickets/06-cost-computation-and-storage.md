# 06 — Cost computation precedence & per-call storage

**Type**: Grilling (HITL) · **Status**: closed · **Claimed by**: wayfinder-session-2026-07-22 · **Blocked by**: 01, 02, 05

## Question

Exactly how is a call's cost computed at ingestion, what wins when multiple
sources disagree, and what is stored on the call?

### Context (from research)

apo today (`backend/apo/services/trace_backend.py:121–139`,
`ingestion.py:149–154, 256–261`, `trace_projector.py:403–431`) has a
three-field precedence: `cost` (effective) → `calculated_cost` →
`provided_cost`. `calculated_cost` is recomputed whenever tokens + a matching
model exist; `cost` is auto-populated from `calculated` only when not already
set.

langfuse (`worker/src/services/IngestionService/index.ts:1282–1354`) is
simpler and stricter: **if the SDK provided any cost, trust it verbatim** and
skip calculation entirely. Otherwise compute `cost[usage_key] = price[usage_key]
* units[usage_key]` for every key, sum to a total. Stores both `provided_*` and
normalized `*` maps in ClickHouse for debugging/re-pricing.

### To decide

- **Precedence rule**: adopt langfuse's "provided wins, else calculate" (simpler,
  clearer) vs keep apo's three-tier `cost → calculated → provided` (more
  flexible but muddier — what does an explicit `cost` with no breakdown mean?).
  The locked display decision (store per-dimension breakdown) pushes toward
  langfuse's model: if you're storing a breakdown, "provided wins verbatim" is
  the only rule that keeps the breakdown coherent with the total.
- **What's stored on each call** (per locked decision 3 — store the
  per-dimension breakdown):
  - The frozen total cost.
  - The per-usage_key cost breakdown (where exactly — see ticket 02).
  - The raw normalized usage map (for re-pricing).
  - The matched model id, matched tier id/name (langfuse stores
    `usage_pricing_tier_id`/`name` — useful for debugging "why this price").
  - The provided cost (if any), separately, so the precedence is auditable.
- **Compute timing**: at span projection (`trace_projector._apply_cost`), as
  today. Confirm this is the single compute point and there's no other path
  that recomputes.
- **Failure modes**: no matching model (cost = null, breakdown = null, usage
  still stored); matching model but missing price for a present usage_key
  (error? skip that key? store a "missing price" marker?); negative or zero
  token counts.

### Scope

Decides the computation rule, precedence, and the exact stored field set.
Coupled to ticket 02 (where breakdown/usage live) and ticket 05 (tier
resolution feeds the prices used).

---

## Resolution

**Resolved 2026-07-22.** Of the ticket's four "to decide" bullets, three
(precedence being the exception) were already determined by tickets 01/02/05.
This ticket settles the precedence rule and confirms the rest, so the spec
writer has the full compute contract in one place.

### 1. Precedence rule — provided wins verbatim, else compute (the one decision)

Adopt langfuse's rule, adapted to apo's per-dimension breakdown:

- **If the SDK provides a cost**, trust it verbatim and skip calculation.
  Two accepted shapes, keeping breakdown coherent with total in both:
  - *Provided breakdown* (`cost_breakdown` map, micro-USD int): use it
    directly as the frozen breakdown; `total = sum(values)`.
  - *Provided scalar* (`provided_cost`, micro-USD int): store it as the
    frozen total; `breakdown = null`.
- **Otherwise compute**: `breakdown[k] = matched_tier_prices[k] ×
  raw_usage[k]` for every canonical key present in *both* the matched tier's
  prices and the call's normalized usage; round each independently to
  micro-USD int; `total = sum(breakdown.values())`.

apo's current three-field model (`cost` effective → `calculated_cost` →
`provided_cost`) collapses. The muddy `cost`/`calculated_cost` split — where
an explicit scalar `cost` could disagree with the per-dimension breakdown —
is replaced by a single effective total that is *always* the sum of the
breakdown (when computed) or the provided value (when provided). A
**provenance** flag (`provided` vs `computed`) is stored alongside so the two
paths remain auditable, replacing the separate-`calculated_cost`-column
audit trail. `provided_cost` is retained as a distinct stored value for the
provided path only.

The locked display decision (ticket 02 / destination decision 3: store
per-dimension breakdown) makes this nearly forced: if the breakdown must be
coherent with the total, "provided wins verbatim" is the only rule that keeps
them coherent without a reconciliation hack.

### 2. What's stored on each call — confirmed from tickets 02 + 05

| Field | Type | Source / notes |
|-------|------|----------------|
| `cost` (frozen total) | int (micro-USD) | sum of breakdown, or provided scalar |
| `cost_breakdown` | `dict[str,int]\|None` (JSON) | per canonical key → micro-USD; `null` when provided-scalar or no match (ticket 02 decision 4) |
| `raw_usage` | `dict[str,int]\|None` (JSON) | normalized usage map, strict superset of priced keys; what re-pricing reads (ticket 02 decision 5) |
| `internal_model_id` | `int\|None` | matched model row (apo already has this column) |
| matched `tier_id` / `tier_name` | `int\|None` / `str\|None` | from the tier match (ticket 05 hands-off; langfuse stores `usage_pricing_tier_id`/`name` — debuggability for "why this price") |
| `provided_cost` | `int\|None` | the SDK-provided value, stored separately when the provided path is taken (audit) |
| provenance | flag (`provided`/`computed`) | replaces the `calculated_cost` audit column |

### 3. Compute timing — confirmed, single compute point

At span projection (`trace_projector._apply_cost`), as today. The legacy
direct-writer (`ingestion.py:150/257`) is the only other path; both call the
normalizer (ticket 03) then this compute. After write, the cost is **frozen**
— re-pricing (ticket 12) is the sole retroactive path.

### 4. Failure modes

- **No matching model** (no model-era row matches `match_pattern` ∋
  `call.start_time`): `cost = null`, `cost_breakdown = null`, `tier_* = null`;
  `raw_usage` **still stored** (ticket 01 decision 3: store-but-unpriced —
  data is never lost; an operator adds the model + re-prices).
- **Matching model, key present in usage but no price row for it**: skip the
  key (contributes 0), keep it in `raw_usage`. Note a *tier* missing a key is
  now impossible — ticket 05 decision 5C enforces same-usage-key-set across
  tiers at write time. So this only fires for a usage key the model doesn't
  price at all (e.g. a brand-new canonical key added to the enum before
  prices exist).
- **Zero token counts**: contribute 0 cost. Fine.
- **Negative token counts**: should never leave a correct normalizer; treat
  as 0 (clamp) and log a warning — don't error ingestion over bad input.

### 5. Rounding — confirmed (already in ticket 02 decision 3)

Round-per-dimension to micro-USD int; `total = sum(breakdown)`. Reconciles
exactly. (The ticket body said this was deferred to 06, but ticket 02's
resolution already pinned it; recorded here so the compute contract is
complete.)

### Hands off to

- **Ticket 09** (migration): apo's existing `cost` / `calculated_cost` /
  `provided_cost` columns must migrate to this shape. The three-field
  precedence collapse is the breaking change. Existing rows where
  `provided_cost` was set but `cost` was computed keep `cost` as the frozen
  total (that's what was displayed); provenance backfills as `computed`.
- **Ticket 11** (dashboard): the tooltip displays `cost_breakdown` directly
  from storage; the "provided vs calculated" flag becomes the provenance
  flag. No client-side recompute (the `model-pricing.ts` bug dies here).
- **Ticket 12** (re-pricing): reads `raw_usage` + current prices/tiers,
  recomputes `cost` + `cost_breakdown` via the same compute function, writes
  back. Only calls with non-null `raw_usage` can be truly repriced.

### Out of scope for this ticket

- Specific migration SQL / column-rename mechanics (ticket 09 / spec).
- Dashboard layout for the breakdown (ticket 11).
- The re-pricing tool's trigger/scope (ticket 12).
