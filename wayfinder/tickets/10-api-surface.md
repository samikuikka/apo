# 10 — API surface (/api/v1/models and related)

**Type**: Grilling (HITL) · **Status**: open · **Claimed by**: — · **Blocked by**: 02, 05, 07

## Question

What do the `/api/v1/models` endpoints become under the new data model, and what
new endpoints (if any) does the cost system need?

### Context

apo today (`backend/apo/routes/models.py`):
- `GET /api/v1/models` — list model definitions.
- `POST /api/v1/models` — create/update a model definition.
- `POST /api/v1/models/seed-defaults` — re-seed `DEFAULT_MODELS`.
- `GET /api/v1/models/match?model=…&prompt_tokens=…&completion_tokens=…` — match
  a model and return its calculated cost.

langfuse's API surface is broader:
- `POST /api/public/models` accepts legacy flat prices OR new `pricingTiers`
  (mutually exclusive).
- A tRPC "preview" endpoint: given model name + sample usage, returns which tier
  would match and its prices — for a "test your pricing config" UI feature.

### To decide

- **CRUD shape**: how does creating a model with tiers + prices look over the
  API? Nested (one POST carries model + tiers + prices, langfuse-style) vs
  separate endpoints per table? Nested is friendlier; separate is more REST-y.
- **Match endpoint**: keep `GET /models/match`, but it now takes a full usage
  map (not just prompt/completion tokens) and returns the matched tier + the
  per-key breakdown. Confirm shape.
- **Preview/test endpoint**: does apo want langfuse's "given usage, show which
  tier matches and the computed cost" endpoint? It's the backbone of a
  "validate your pricing config" UI feature. Worth it for v1?
- **Backward compatibility**: the dashboard (`apps/dashboard/src/lib/model-pricing.ts`)
  and CLI hit these endpoints. Do we version-bump (`/api/v2/models`) or mutate
  `/v1` in place? apo is pre-1.0 — in-place is likely fine, confirm.
- **Regex inconsistency fix**: backend uses unanchored `re.search`, frontend uses
  anchored `^…$` (`model-pricing.ts:61–79`). The new API should return the
  canonical match semantics so client and server agree. Decide the canonical
  rule (anchored full-match, like langfuse's `(?i)^…$`, is the safe default).

### Scope

Decides endpoint shapes, the match/preview question, and match-semantics
canonicalization. Doesn't decide the dashboard's UI (ticket 11).
