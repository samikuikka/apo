# 11 — Dashboard cost display

**Type**: Prototype (HITL) · **Status**: closed · **Claimed by**: cost-session-12 · **Blocked by**: 06, 10

## Question

How does the dashboard present the new per-dimension cost breakdown — in the
existing cost tooltip, in trace detail, in run/session aggregations — given that
a call can now have many contributing dimensions (input, cache_read,
cache_write_5m, output, reasoning, …)?

This is a prototype ticket: raise fidelity by sketching concrete UI before
committing to layouts.

### Context

apo's current cost UI:
- `CostBreakdownTooltip.tsx` — shows input/output/total with per-1K price;
  flags "Provided/Calculated" when they diverge.
- `TraceDetailTabs.tsx` — `costs` tab: total + per-model breakdown; `tokens` tab.
- `TraceDetailView.tsx`, `TraceTree.tsx`, `columns.tsx` — cost cells, heat
  coloring, cumulative rollup.
- `model-pricing.ts` — client-side recompute with the regex-anchoring bug.

With N possible dimensions per call, the "input/output" two-row breakdown no
longer fits. Per-model rollups (run/session) get richer too — a model's total
now sums many dimensions.

### To decide (via prototype)

- **Tooltip layout**: how to show 1–N dimensions compactly. Group by
  input-family (input / cache_read / cache_write_5m / cache_write_1h) and
  output-family (output / reasoning)? Sort by magnitude? Truncate with "…"?
  Prototype 2–3 layouts and react to them.
- **Aggregation display**: per-model rollup across a run/session — show the
  dimension mix as a stacked bar? A table? Just the total with a tooltip?
- **"Provided vs calculated" surfacing**: keep the existing flag, extend to show
  which dimensions were provided vs calculated?
- **Client-side compute**: `model-pricing.ts` recomputes breakdowns client-side
  (and has the regex-anchoring bug). With breakdowns now stored server-side
  (ticket 06), does the client still need to recompute at all, or does it just
  display stored values? Removing client-side recompute kills the bug and
  simplifies — confirm.
- **Stale-price indication**: if a model is unpriced or priced from a stale
  window, how is that surfaced visually? (Coupled to ticket 08's staleness
  signal.)

### Scope

Decides the display layouts and whether client-side recompute stays. Produce a
prototype (sketch or stub component) as the asset; the production implementation
is spec work.

---

## Resolution

**Resolved 2026-07-22.** Prototype built as the asset:
[`wayfinder/prototypes/cost-display-prototype.html`](../prototypes/cost-display-prototype.html)
(open in a browser — self-contained, uses apo's exact OKLCH tokens and the
tooltip's inverted surface). The decisions below are what the prototype
validated; it's throwaway and should be deleted once the spec absorbs the
verdict.

### The design constraint that shapes everything

apo's `design.md` is explicit: **"Color = state, not decoration. If it doesn't
signal state, it should be gray."** A cost dimension (input, cache_read,
reasoning…) is *identity*, not state — so the six canonical keys get six
**monochrome grayscale shades**, never hues. The single exception, where hue
*is* warranted, is the one genuine state transition: an **unpriced dimension**
surfaces in `--warning` amber. This keeps the breakdown legible without
introducing a rainbow that would fight the monochrome identity and clash with
the existing percentile heat-color (which is about *magnitude relative to
peers*, a different axis entirely — left untouched).

### 1. Tooltip layout — group by family, sort by magnitude, total above the rule

The current tooltip (`CostBreakdownTooltip.tsx`) is built for exactly two rows
(input / output). Scaling to 1–6 dimensions by adding rows linearly produces a
wall. The validated layout:

- **Two labeled family groups**: Input (`input`, `cache_read`,
  `cache_write_5m`, `cache_write_1h`) and Output (`output`, `reasoning`).
  Matches how providers think about tokens (read-side vs write-side) and how
  ticket 05's large-context tier sums `input + cache_read` (the read family).
- **Within a family, sort by descending cost** and **hide zero-cost rows.** A
  dimension priced at 0 for this call (e.g. no cache_write) isn't interesting;
  showing it adds noise. Hiding keeps a 2-dim call compact and a 6-dim call
  scannable.
- **Total on its own row above the rule** (not below) — the eye lands on the
  headline number first, detail below. Matches the current "Total:" row but
  repositioned to the top.
- **Provenance as a quiet footer** (`computed · tier: large-context` or
  `provided by SDK · no breakdown`), not the old "Provided: $X · Calculated: $Y"
  two-number row. Ticket 06 collapsed `cost`/`calculated_cost`/`provided_cost`
  into one effective total + a provenance flag; the tooltip must honor that
  collapse, not re-show the split. The `costsDiffer` divergence-flag logic
  (`Math.abs(provided - calculated) > 0.0001`) is deleted.

### 2. Provenance surfacing — flag, not parallel number

The "Provided vs Calculated" two-number display is removed entirely. One total,
one provenance word at the footer. This is forced by ticket 06: there is no
longer a `calculated_cost` column to display alongside `cost` — the provenance
flag (`provided` / `computed`) is the only record of which path produced the
number, and it's a label, not a competing value. A provided call simply has no
breakdown to show (the SDK gave a scalar); a computed call shows the breakdown.
No comparison view.

### 3. Client-side recompute — removed (`model-pricing.ts` dies)

`apps/dashboard/src/lib/model-pricing.ts` is **deleted in full**:
`fetchModelPricing`, `matchModelPricing`, `computeCallBreakdown`,
`computeRunBreakdown`. The dashboard reads **stored** `cost_breakdown` (ticket
06) directly — no client-side pricing fetch, no client-side matching, no
client-side multiply.

This kills three problems at once:
- The **regex-anchoring mismatch** (frontend `^…$` vs backend `re.search`) —
  ticket 10 made matching server-side only; the client no longer matches at all.
- The **stale-price recompute** (client fetches `/api/v1/models` and recomputes
  against *current* prices, contradicting frozen-at-ingestion from ticket 06).
- The **per-call network fetch** of the pricing table on every tooltip mount.

`computeRunBreakdown` (which sums stored `call.cost` by model, no pricing
fetch) is trivial enough to inline at its two call sites; it doesn't justify a
library module.

### 4. Unpriced dimensions — amber, not silent

A usage key present in `raw_usage` but with no price row (ticket 06
failure-mode 2, e.g. a brand-new `reasoning` key before prices exist) renders
as `reasoning · 980 tok — unpriced` in `--warning` amber, with a ⚠ footer
("reasoning has no price for this model"). This makes a mispriced model
**debuggable after the fact** — the explicitly stated purpose of storing the
per-dimension breakdown (locked decision 3). Without this, a missing price is
invisible (the dimension silently contributes 0), and the whole point of the
breakdown is lost.

### 5. Legacy calls — "no breakdown stored," no synthesis

Pre-migration calls (ticket 09: `cost_breakdown` / `raw_usage` null) show the
scalar total + a quiet "legacy call · no breakdown stored (pre-migration)"
footer. **No synthesis from current prices** — ticket 04's time-windowing makes
that misleading (current price ≠ the era's price when the call happened). The
dashboard renders the honest "we don't have this" rather than a fabricated
breakdown.

### 6. Run/session rollup — dimension mix bar, optional

The trace-detail "costs" tab's per-model breakdown gains a **3px-tall
monochrome mix bar** under each model — one glance shows whether a model's
cost is input-dominated, cache-heavy, or reasoning-heavy. Same
shade-per-dimension key as the tooltip (shared legend). This is the
debuggability affordance at the aggregate level.

List views (runs table, sessions, task-run-list) **stay scalar** — a single
total per row. A dimension breakdown doesn't belong in a dense table; the
tooltip-on-hover carries the mix for anyone who wants it. The existing
percentile heat-color (`lib/heatmap.ts`, green→red by relative magnitude)
stays for list/table cost cells — it answers a different question ("expensive
relative to peers?") than the breakdown ("where did the cost come from?").

### 7. Formatting — one function, four tiers (consolidate)

The codebase has four inconsistent cost formatters (`usdFormat`/`formatCost`
with 3 tiers; a local `TraceDetailTabs` `formatCost` with 2 tiers; raw
`.toFixed(4)`/`.toFixed(6)` scattered inline). The spec consolidates to one:
`usdFormat` in `lib/format.ts` (≥$1 → 2dp, ≥$0.01 → 4dp, else 6dp), used
everywhere. Every cost number stays `font-mono tabular-nums` per `design.md`.

### Out of scope for this ticket

- Exact component decomposition (CostBreakdownTooltip becomes
  DimensionBreakdownTooltip; the mix bar is a new `<DimensionMixBar>` — spec
  decides file structure).
- The trace-tree heat color (`trace-heatmap.ts`, fixed-threshold raw classes) —
  pre-existing, not part of this redesign, may be tokenized in a separate pass.
- A pricing-config editor UI (model/tier editing) — that's a product feature
  beyond cost-system correctness.

### Hands off to

- **Ticket 13** (testing): the tooltip and mix bar are pure functions of stored
  `cost_breakdown` — unit-test the layout logic (family grouping, sort, hide-
  zero, unpriced-amber) over fixture breakdowns covering all six states above.
  No pricing-fetch mocking needed (the fetch is gone).
- **Spec writer**: `model-pricing.ts` deletion touches two importers
  (`CostBreakdownTooltip.tsx`, `columns.tsx`'s `UsageCell`); both are rewritten
  to read stored breakdowns. The `ModelPricing` type, `fetchModelPricing`
  singleton, and the `pricingCache` in `columns.tsx` are all removed.

### Fog graduated / clarified

- **Stale-price indication** (listed in the ticket body): resolved — an unpriced
  dimension *is* the stale-price signal, surfaced via amber per decision 4. A
  separate "stale window" indicator would couple to ticket 08's staleness
  signal, which is post-v1; the per-dimension amber covers the debuggability
  need for now.
