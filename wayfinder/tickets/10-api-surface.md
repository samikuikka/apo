# 10 — API surface (/api/v1/models and related)

**Type**: Grilling (HITL) · **Status**: closed · **Claimed by**: cost-session-12 · **Blocked by**: 02, 05, 07

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

---

## Resolution

**Resolved 2026-07-22.** All five bullets settled with documented reasoning.
The throughline: the model's validity is a graph-level property (ticket 05's
tier invariants, ticket 04's one-era-active rule), so the API exposes the model
as one document, validates it as one unit, and the flat single-table CRUD of
today is replaced by nested document endpoints.

### 1. CRUD shape — nested document (model + tiers + prices in one call)

One `POST /api/v1/models` carries the whole model document — model fields
plus a `pricingTiers[]` array, each tier carrying its `conditions` and a
`prices{}` map keyed by ticket 01's canonical usage keys. `PUT /api/v1/models/{id}`
replaces the whole graph for an existing model (delete-old-tiers-and-prices →
insert-new, one transaction, re-validate). Reads (`GET /api/v1/models`,
`GET /api/v1/models/{id}`) return the nested shape.

Why nested, not per-table endpoints:

- **Validity is graph-level.** Ticket 05's invariants (exactly one default tier
  per model; same usage-key set across all tiers) and ticket 04's rule
  (one-era-active for `(model, project)`) are properties of the *whole* tier/era
  set, not any single row. Per-table endpoints would either accept invalid
  intermediate states (a model with no tiers, two default tiers, mismatched key
  sets) or defer validation to a "finalize" step — friction for no REST-purity
  payoff. Nested POST validates the full graph in one transaction.
- **Same shape as the JSON defaults file** (ticket 07: array of models with
  `pricingTiers[]`, prices keyed by canonical keys, tier `conditions` as
  `{keys,operator,threshold}`). The API write shape and the seed-file shape being
  identical means one mental model — a user can lift a JSON entry into an API
  call verbatim, and the loader (ticket 07) and the API path share validation.
- **Real clients want document granularity.** Dashboard and CLI both want
  "give me this model's full config" in one read and "save my edits" in one
  write — the nested document's natural unit. Nobody benefits from
  tier-level endpoints here.

The endpoint replaces the flat `POST /api/v1/models` + `POST /seed-defaults`
pair. `seed-defaults` is **removed** — the JSON loader (ticket 07) runs on
startup and is the sole seed path; there's no runtime re-seed because JSON is
the source of truth for globals (ticket 07 decision).

### 2. Per-project only — POST/PUT reject `__global__`

`POST`/`PUT /api/v1/models` **reject** any request targeting `project="__global__"`
with a `409` (or `403`) and a message directing the user to edit the bundled
JSON or create a per-project override. This is the direct consequence of ticket
07's decision that JSON is the sole source of truth for `__global__` (re-applied
every startup, globals absent from the file are deleted, edits reverted). A
writable global API path would fight the loader — every restart would clobber
API-written globals. Per-project overrides are the user's customization surface;
globals are authored in the release JSON (ticket 08's maintenance workflow).

`GET /api/v1/models?project=__global__` still **reads** globals (the dashboard
needs to display them, and per-project overrides compose over them) — only the
write path is closed. The effective view for a project is "globals overlaid with
the project's overrides"; a `GET /api/v1/models?project=<id>&effective=true` flag
returns the merged view (project rows shadow global rows by `match_pattern`), so
the dashboard fetches one list instead of two and stitching client-side. Whether
`effective` ships in v1 or the client merges is a spec call; the merge semantics
(project-wins per `match_pattern`) are fixed here.

### 3. Match endpoint — kept, upgraded to a full usage map + breakdown

`GET /api/v1/models/match` stays but is upgraded to the new compute contract:

- **Inputs**: `model` (string) + a full `usage` map (JSON or repeated query
  params) of canonical-key → token count, plus optional `start_time` (defaults
  to now). The old `prompt_tokens`/`completion_tokens` scalar pair is dropped —
  it can't represent cache/reasoning dimensions, so it can't preview real cost.
- **Returns**: `{matched, model_id, model_name, provider, matched_tier_id,
  matched_tier_name, cost_breakdown: {key: micro_usd…}, total_cost}` — the same
  fields stored on a call at ingestion (ticket 06), so the endpoint is literally
  "what would ingestion freeze for this usage?" Reuses the identical
  model-era→tier→price→compute pipeline (tickets 04/05/06). No parallel math.
- `start_time` selects the era (ticket 04: `[start,end) ∋ start_time`), so a
  caller can ask "what would this cost *as of* last January?" — the same query
  the re-pricing tool makes (ticket 12). The match endpoint and re-pricing share
  the resolution function.

This is **not** a separate "preview/test" endpoint (next bullet). It's the
existing match endpoint, expanded to the new data model. The dashboard's
client-side `model-pricing.ts` recompute (with the regex-anchoring bug) is
**removed** by ticket 11 — the dashboard calls this endpoint or reads stored
breakdowns instead. The match endpoint survives as the "compute cost for
arbitrary usage without ingesting" path (used by the CLI's `runs`/`traces`
display, and by a future "validate pricing config" UI).

### 4. No separate preview/test endpoint in v1

langfuse's tRPC "preview" endpoint (given model name + usage, return matched
tier + prices) is **the match endpoint** (bullet 3) — apo doesn't duplicate it
under a different name. There's no v1 "validate your pricing config" dashboard
feature that would justify a distinct preview surface; the match endpoint serves
both "what would this cost?" and "which tier matches?" via its response shape.

If a later product need (a pricing-config validator UI) wants a richer preview
(e.g. "show me all tiers and why each did/didn't match"), that graduates from
fog — but it's not needed for the cost system to be correct.

### 5. Match semantics — anchored full-match, canonicalized server-side

The backend's unanchored `re.search` vs the frontend's anchored `^…$` mismatch
(the current bug) is resolved by **making anchored full-match the single rule,
enforced server-side**, and returning the canonical semantics to all clients:

- **Rule**: a `match_pattern` matches a model name iff
  `re.fullmatch(pattern, name, re.IGNORECASE)` succeeds. Equivalent to langfuse's
  `(?i)^…$`. Anchored, case-insensitive, full-string match.
- **Server is the only matcher.** The match endpoint (and ingestion) use this
  rule; clients stop matching locally. The dashboard's `model-pricing.ts`
  `matchModelPricing` is removed (ticket 11) — the dashboard fetches
  matched/stored results, never recomputes. The CLI hits the match endpoint.
- **Fallback**: an invalid regex pattern falls back to exact string equality
  (case-insensitive), preserving today's graceful-degradation behavior — never
  raises on a bad pattern at match time. Invalid patterns in a `POST`/`PUT` or
  the JSON file are rejected at **write** time (validation, bullet 1), not at
  match time.

This kills the client/server divergence at the source: one matcher, server-side,
anchored.

### What the endpoint set becomes

| Method + path | Purpose |
|---|---|
| `GET /api/v1/models?project=&effective=` | list models (per-project, or merged global+project view) |
| `GET /api/v1/models/{id}` | full nested model document (model + tiers + prices) |
| `POST /api/v1/models` | create per-project model (nested; rejects `__global__`) |
| `PUT /api/v1/models/{id}` | replace model's tier/price graph (rejects `__global__`) |
| `DELETE /api/v1/models/{id}` | delete a per-project model (rejects `__global__` — globals are JSON-controlled) |
| `GET /api/v1/models/match` | resolve model+usage → tier + breakdown (shared with ingestion/reprice) |

`POST /seed-defaults` is removed (loader is the sole seed path).

### Versioning — in-place on `/v1`

apo is pre-1.0 (ticket 09 cited v0.2.0) with no external API consumers of these
endpoints (the dashboard and CLI are internal and migrate together). So the
endpoints mutate `/v1` **in place** — no `/v2`. This matches ticket 09's big-bang
cutover philosophy: one release changes schema + API together, no compatibility
window. The breaking change is documented in the release notes.

### Out of scope for this ticket

- Exact request/response Pydantic schemas (ticket 02 defines the table models;
  the API schemas mirror them — spec work).
- Dashboard UI for editing models (ticket 11 is the display ticket; a model-edit
  UI is a separate product feature beyond the cost system's correctness).
- CLI pricing-edit command (the fog below; not needed for correctness).

### Hands off to

- **Ticket 11** (dashboard): `model-pricing.ts` is removed; the dashboard reads
  stored breakdowns (ticket 06) or calls `GET /models/match`. No client-side
  matching or recompute. The regex bug dies here.
- **Ticket 13** (testing): the match endpoint is the integration seam for
  tier-resolution + compute — one test per (model-era, usage) → expected
  breakdown, reusing the ticket 06 compute fixtures. Write-path validation
  (reject globals, enforce tier invariants) earns its own tests.
- **Spec writer**: the `ModelDefinitionCreate/Response` Pydantic models in
  `models/pricing.py` are replaced by nested schemas mirroring the 3-table shape
  (ticket 02). Routes move from the flat `models.py` shape to the document shape
  above. `find_matching_model` becomes `re.fullmatch`-based and is shared by
  ingestion, match, and reprice.

### Fog graduated / clarified

- **CLI surface** (map fog): the API surface is now fixed. Whether the CLI needs
  a pricing-edit command is now specifiable — but the answer is "no for v1":
  globals are JSON-authored (ticket 08), per-project overrides use the API, and
  a CLI `models edit` command is a convenience wrapper over `PUT`, not a
  correctness need. Recorded as a closed sub-decision; the broader CLI-surface
  fog (other cost-display commands) is unaffected.
