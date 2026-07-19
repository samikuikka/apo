# 08 — JSON defaults: maintenance workflow

**Type**: Grilling (HITL) · **Status**: open · **Claimed by**: — · **Blocked by**: 07

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
