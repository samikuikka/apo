# 08 — JSON defaults: maintenance workflow

**Type**: Grilling (HITL) · **Status**: closed · **Claimed by**: cost-session-08 · **Blocked by**: 07

## Question

How does the bundled JSON defaults file stay fresh over time? Who updates it,
how often, and what signals staleness?

Locked decision 4 picked "JSON shipped with the release" knowing the trade-off:
freshness depends on someone maintaining the file. This ticket decides the
workflow that makes maintenance tractable rather than a forgotten chore.

### Context

langfuse updates their JSON via PRs to the repo — no automation, no freshness
signal, no schedule visible in the codebase. It works for them because they're
a company with maintainers whose job includes pricing.

apo is smaller. Risks: (a) the JSON goes stale, users see wrong costs silently;
(b) a contributor adds a model with a typo'd price and nobody catches it; (c)
nobody knows the file exists.

### To decide

- **Sourcing new prices**: when adding/updating a model, where does the price
  come from? Provider's pricing page (manual), a community list used as a
  *reference* (not a runtime feed — e.g. check LiteLLM's JSON during PR review
  but hand-write apo's entry), or something else? The locked decision rules out
  runtime fetch; this is about the *authoring* workflow.
- **Staleness signal**: a CI check that flags models in the JSON older than N
  months for review? A `last_reviewed` per-model field surfaced in the dashboard
  / a CLI command? A "this model is N months stale" warning at ingestion if a
  model has no price match? Pick what's worth the upkeep.
- **Review gate**: PR template / CI validation that every new model entry has
  required fields (provider, match regex, at least one tier, prices for the
  canonical keys the provider emits)? Coupled to ticket 05's validation rules.
- **Cadence**: is there an expected review cadence (e.g. monthly), or purely
  on-demand ("new model dropped, someone adds it")? On-demand is realistic for
  apo's size; a cadence is aspirational.
- **Ownership**: who owns this file in practice? (Likely "whoever ships a
  release" — make that explicit in docs.)

### Scope

Decides the maintenance workflow, staleness signal, and review gate. Doesn't
decide the file format (ticket 07) or specific model entries (data).

---

## Resolution

**Resolved 2026-07-22 via /grilling.** The bundled JSON defaults stay fresh
through a layered workflow, all of it maintainer-facing — no part of this
reaches the running apo instance or the end user. The staleness signal and
the review gate are **two different mechanisms catching two different failure
modes**, and that distinction drives every sub-decision.

### The two failure modes — and which layer catches each

| Failure | Example | Caught by |
|---|---|---|
| **Missing model** | new model shipped, nobody added it | runtime: per-dimension amber on the stored breakdown (ticket 11 decision 4) — out of scope here |
| **Stale price** | model exists in JSON but its price changed, silently wrong | **this ticket's** `last_reviewed` field + CI age check |

The current seed shows apo hits both (`no Claude 3.7/4` = missing;
unchanged entries from 2026-01 = likely stale). Ticket 11 already owns the
*runtime* debuggability layer (amber); ticket 08 owns the *maintainer*
freshness layer. The two do not overlap.

### Decisions

1. **Cadence — on-demand PRs + staleness signal.** Models are added/updated
   purely on-demand via PRs (langfuse's model), but *unlike* langfuse apo
   carries an explicit freshness signal, because nobody's full-time job is
   pricing. No scheduled refresh — that would become an ignored chore at
   apo's size.

2. **Staleness signal — `last_reviewed` per-model field in the JSON + CI age
   check.** Each model entry carries `last_reviewed: "2026-07"` (a review
   pass bumps it *even if the price didn't change* — this is what
   distinguishes "reviewed" from "changed"). A CI job flags entries older
   than ~4 months for review. The age threshold is advisory (a warning, not
   a hard fail): a correctly-priced model simply hasn't needed a change, and
   failing CI on it would nag the release shipper into noise-blindness.

3. **Where `last_reviewed` lives — JSON-only, never the DB.** The field is
   read straight from the bundled file by CI; the loader (ticket 07) never
   sees it and never writes it to a row. This is deliberate: it keeps
   ticket 07's `updatedAt`-exact-equality idempotency gate **completely
   untouched**. A review pass that only bumps `last_reviewed` changes
   `updatedAt` by nothing, so the loader skips the DB write — the freshness
   signal and the seeding mechanism are fully decoupled. Consequence: the
   signal is **maintainer-facing only** (CI output), not surfaced in the
   dashboard or CLI — by design, and consistent with ticket 11 leaving
   "stale window" indicators to post-v1.

4. **Review gate — CI validation script + schema.** A job (a small script
   in the existing `ci.yml`, run on every PR touching the JSON) loads the
   file and validates each entry against ticket 05's locked rules: required
   fields present (provider, match_pattern, at least one tier, prices for
   the canonical keys the provider emits), exactly one default tier per
   model, the same usage_key set across all tiers of a model, `last_reviewed`
   present and parseable, and a JSON Schema (or the typed loader from ticket
   07) for structure. This catches malformed and wrong-but-well-formed
   entries (missing default tier, mismatched key sets) mechanically — the
   reviewer doesn't have to eyeball structure. A PR template is **not**
   added; the script is the hard gate, and a markdown checklist the
   contributor might ignore adds a sync burden without a second net.

5. **Sourcing — provider pricing page, hand-written; LiteLLM as a
   cross-check reference only, never imported.** The contributor reads the
   price from the provider's official page and hand-writes the entry.
   LiteLLM's bundled JSON may be consulted during review as a sanity
   reference but is never imported or diffed in CI — apo decouples from any
   third-party list's correctness, staleness, and licensing. The CI script
   validates *structure*, not *value*; the reviewer is the only check on
   the number, cross-checked against the provider page.

6. **Ownership — "whoever ships a release," documented + CI-nagged.** Made
   explicit in the JSON file's header comment and a short maintainer note in
   the self-hosting docs: a release with no pricing refresh should bump
   `last_reviewed` on the entries reviewed. No named maintainer/role (apo
   has no stable owner for this niche; a stale name is worse than an event-
   anchored duty). The CI age check enforces it passively: stale entries
   nag whoever cuts the release.

### Hands off to

- **Spec writer** (new build spec in `specs/`): the JSON file's per-entry
  shape gains a `last_reviewed` field (format: `"YYYY-MM"`) — must be added
  to ticket 07's entry shape in the spec. The CI validation script is a new
  `.github/workflows` step or a `scripts/` entry invoked from `ci.yml`.
  The file header comment and the maintainer note in docs are spec work.
- **Ticket 13** (testing): the CI validation script itself is worth a unit
  test — feed it a fixture JSON with each of the rule violations (missing
  default tier, mismatched key sets, unparseable date) and assert it flags
  the right entry.

### Out of scope reaffirmed

- A *runtime* staleness signal (dashboard/CLI showing "model's price is N
  months stale" to end users) — this is post-v1 and a different layer than
  what this ticket owns. Ticket 11's per-dimension amber is the runtime
  debuggability affordance; this ticket is the maintainer freshness layer.
- Scheduled/cron refresh of the JSON — ruled out; on-demand + the signal
  covers it.
