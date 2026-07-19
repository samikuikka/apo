# 11 — Dashboard cost display

**Type**: Prototype (HITL) · **Status**: open · **Claimed by**: — · **Blocked by**: 06, 10

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
