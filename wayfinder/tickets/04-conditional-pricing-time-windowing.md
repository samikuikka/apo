# 04 — Conditional pricing: time-windowing

**Type**: Grilling (HITL) · **Status**: closed · **Claimed by**: wayfinder-session-2026-07-21 · **Blocked by**: 02

## Question

How does apo express that a model's price changes over time (e.g. a provider
cuts input price on March 1; old calls should price at the old rate, new calls
at the new rate)?

This is half of "conditional pricing is a declarative layer on top" (locked
decision 1). The other half is tier conditions (ticket 05).

### Context

langfuse puts `startDate DateTime?` on the `Model` table and resolves at
ingestion with `ORDER BY … start_date DESC NULLS LAST` — newest matching window
wins. apo's current `ModelDefinitionDB` has no time field.

The locked history decision ("frozen at ingestion, re-pricing available") means
time-windowing matters in two places:
1. At ingestion — pick the price window in effect *when the call happened* (for
   late-arriving spans this is the call's timestamp, not ingestion time).
2. At re-pricing — the tool must apply windows correctly across history.

### To decide

- **Granularity**: time-window on the model (one model, many dated price rows —
  langfuse's approach) vs on the tier (a tier is valid in a window) vs on the
  price row itself. Coupled to ticket 02's table shape — likely decided there.
- **Window semantics**: `[start, end)` half-open? `NULL` end = open-ended?
  Overlapping windows — error, or "newest start wins"?
- **Late-arriving data**: call timestamp is 2 days ago, ingestion is now —
  which window applies? (Should be the call's timestamp.)
- **Editing a window mid-stream**: if a user fixes a window retroactively, do
  already-ingested calls stay frozen (yes, per locked decision) and only future
  calls pick up the fix? Confirm, and how re-pricing interacts.

### Scope

Decides the time-windowing semantics and where it lives in the data model.
Doesn't decide the tier engine (ticket 05) or the re-pricing tool's UX (ticket
12).

---

## Resolution

**Resolved 2026-07-21.** Five decisions, closing every open question above.
Every decision weighed against the standing preference: *does this scale to N
providers/models without code changes?*

1. **Window placement — on the model.** The time-window lives on the `models`
   row (langfuse's placement; ticket 02 already slotted `start_date` /
   `end_date` columns there). One model row per price era: a provider cuts
   input price on March 1 → you add a *second* `models` row with the same
   `match_pattern`, a `start_date` of March 1, and the new prices; both rows
   match the pattern and ingestion picks the era in effect at call time. This
   is the open-enum-friendly, query-simplest option, and — critically — it
   keeps the two condition layers cleanly separated: **time is the model's
   job, usage is the tier's job** (see decision 5). They never interact at the
   query level. The redundancy of duplicating the full price set per era is
   negligible (eras are rare — a handful per model per year) and buys a flat,
   indexable lookup. Rejected: window-on-tier (conflates time and usage
   conditions, breaks resolution order) and window-on-price-row (makes the
   per-call price lookup a per-dimension self-join, undermining ticket 02's
   reason for making `prices` a table).

2. **Window shape — half-open `[start, end)`, `NULL` end = open-ended,
   overlap = write-time validation error.** Both columns kept (ticket 02
   slotted them). `[start, end)` is self-contained per row: you can look at
   one era and know exactly when it applied, which makes re-pricing (ticket
   12) and debugging straightforward. `NULL` `end_date` means "still active."
   Inserting a new era closes the previous one's `end_date` in the same
   transaction (one extra UPDATE, trivial). **Overlapping windows for the same
   `(model, project)` are rejected at write time** (API/upsert), not silently
   disambiguated at runtime — so "one era active at any instant" is an
   invariant the data enforces, the query never has to disambiguate, and a
   misconfigured model fails loudly at config time rather than silently
   mispricing a million calls. Rejected: langfuse's `start_date`-only,
   newest-start-wins (can't tell from one row when it stopped applying;
   silently tolerates overlaps).

   **Divergence from langfuse, made explicit.** langfuse's ingestion query
   (`packages/shared/src/server/ingestion/modelMatch.ts:285–298`) does
   `ORDER BY start_date DESC NULLS LAST LIMIT 1` with **no temporal
   predicate** — so a late-arriving span prices at the *newest* era overall,
   not the era in effect when the call happened. apo's ingestion must add the
   predicate langfuse lacks:

   ```sql
   WHERE match_pattern matches :model
     AND (start_date IS NULL OR start_date <= :call_ts)
     AND (end_date   IS NULL OR end_date   >  :call_ts)
   ```

   The `start_date IS NULL` clause covers legacy/seeded rows with no window
   (treated as "always active on the lower bound"), matching apo's existing
   `ModelDefinitionDB` which has no time field. This predicate is what makes
   the locked "frozen at ingestion = what was actually paid" principle
   *correct* for late-arriving spans, instead of langfuse's approximation.

3. **Window key — `call.start_time`, fallback to ingestion-time + visible
   flag.** The call's OTel `gen_ai` span `start_time` (when the LLM call
   actually happened) is the window key, because that's what was *actually
   paid* — matching the locked history principle. For a span emitted 2 days
   ago and ingested now, `start_time` is 2 days ago; the call prices against
   the era in effect 2 days ago, not today. If `start_time` is absent
   (malformed/legacy OTel), fall back to ingestion time (`now`) and **flag
   the call** (visible note in the breakdown and/or operator log) so it's
   known that the call's historical pricing is best-effort — never silent,
   because a wrong-era price is a real money error. Era-boundary-mid-call
   (start in one era, end in another) is deliberately not engineered for:
   LLM calls are seconds, era boundaries are calendar dates, so the case
   isn't real. Rejected: always-ingestion-time (violates "what was actually
   paid" for any late span) and `end_time` (more often missing than
   `start_time`, and solves a non-case).

4. **Retroactive window edits — frozen; re-pricing is the sole retroactive
   path.** Editing a window that already covered ingested calls (fixing a
   wrong price, shifting a boundary) **does not rewrite history**: frozen
   calls stay frozen (locked decision 2). The edit updates the price table
   only; future calls pick up the new config. To change historical cost, the
   user runs the **re-pricing tool** (ticket 12), which re-applies the
   *current* windows + tiers against each call's `start_time` and
   `raw_usage` — so a shifted boundary can legitimately re-era a call, which
   is exactly the point of fixing a misconfigured window. No bi-temporal
   price-version table: the price table is the *current* truth, frozen
   `cost` / `cost_breakdown` on calls is the *historical* truth, and
   re-pricing bridges them on demand. This keeps the model simple and matches
   what the locked decisions already committed to. (Ticket 12 owns the
   tool's UX; this ticket only pins the contract re-pricing must honor.)

5. **Resolution order — model-era → tier → prices; tier conditions are
     usage-only; default tier is fallback.** Ingestion's price resolution is
   a three-step pipeline:

   1. **Resolve the model era** — `match_pattern` + the temporal predicate
      from decision 2 → exactly one `models` row (the invariant from
      decision 2 guarantees uniqueness).
   2. **Resolve the tier within that model** — among that model's
      `pricing_tiers`, take the first (by priority) whose conditions pass;
      else the model's default tier.
   3. **Look up prices** — `(model_id, tier_id, usage_key) → price` rows
      (ticket 02's key) for the present usage keys.

   Because the window is on the model, `model_id` *already encodes the era*
   (one model row per era), so the price lookup is automatically era-correct
   with no extra column — resolving the model era is sufficient; the tier
   step operates within the already-era-correct model. **Tier conditions are
   evaluated on the call's usage only, never on time** (time is the model's
   job), and **the default tier prices the call when no condition tier
   matches** (no error on unmatched). This pins the seam with ticket 05: it
   only designs the condition language and validation, not the resolution
   order or the time interaction.

### Out of scope for this ticket

- The tier condition language, its validation, and default-tier mechanics
  beyond "it's the fallback" (ticket 05 — handed a resolved contract by
  decision 5).
- The re-pricing tool's UX and scope (ticket 12 — handed the contract by
  decision 4).
- Exact migration SQL for the new columns / era backfill (spec/impl detail;
  ticket 09 owns the *what* of migration).

### Graduates fog

- The **"no overlapping time-windows for the same `(model, project)`"**
  validation rule is now decided (decision 2) and graduates from the map's
  "Validation rules" fog line. The rest of that line (one-default-tier,
  same-usage-key-set across tiers, regex safety, tier condition shape) still
  waits on ticket 05, as the map already notes.

