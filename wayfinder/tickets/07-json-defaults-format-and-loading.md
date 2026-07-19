# 07 — JSON defaults: format & loading

**Type**: Grilling (HITL) · **Status**: closed · **Claimed by**: cost-session-2026-07-22 · **Blocked by**: 02, 05

## Question

What is the format of the bundled JSON defaults file, and how is it loaded into
the DB at startup?

### Context

langfuse ships `worker/src/constants/default-model-prices.json` (4197 lines,
~all global models), loaded at startup by `worker/src/initialize.ts:5` calling
`upsertDefaultModelPrices()`. The upsert (`scripts/upsertDefaultModelPrices.ts`)
is idempotent: it skips models whose `updatedAt` + tier IDs already match the
DB (so a no-op restart runs one SELECT), and per-model in a transaction does
upsert-model → delete-stale-tiers → upsert-each-tier-and-its-prices. JSON is
the source of truth for defaults; per-project overrides live only in the DB.

Locked decision 4: apo ships defaults as a JSON file in the release, loaded and
upserted idempotently on startup. No remote fetch.

### To decide

- **File location**: `backend/apo/data/default-model-prices.json`? Confirm the
  `data/` convention (apo doesn't have one yet — may need creating).
- **Entry shape**: langfuse's full shape (model → tiers[] → prices{}, with
  tokenizer fields, matchPattern regex, startDate) vs an apo-minimal shape.
  Tokenizer fields are out of scope (map's Out of scope); matchPattern and
  startDate stay.
- **Pricing units in the file**: per-token (langfuse, e.g. `0.0000025`) vs
  per-1M-tokens (apo's current convention, e.g. `2.50`). Per-token avoids
  scaling bugs but is hard to read/edit by hand; per-1M is the convention every
  provider publishes in. Pick one, document it, enforce it.
- **Loading timing**: `init_db` (`backend/apo/db.py:170`) already calls
  `seed_default_models` after `create_all` + migrations. The new loader replaces
  this. Confirm it runs once per process startup, idempotently.
- **Upsert semantics**: langfuse is "JSON is source of truth for defaults —
  delete DB rows not in JSON." But apo lets users edit globals via the API too
  (today's `POST /api/v1/models`). Conflict: if a user edits a global model's
  price and then restarts, does the JSON clobber their edit? Decide: (a) JSON
  always wins for globals (user edits to globals are ephemeral — steer users to
  per-project overrides), (b) JSON writes only on first seed / explicit re-seed,
  (c) versioned JSON with a "last-applied version" tracked in DB.
- **Validation on load**: reject the file (fail startup) vs warn-and-skip on
  malformed entries. Coupled to ticket 05's validation rules.

### Scope

Decides file format, location, units, loading semantics, and the
user-edit-vs-JSON conflict resolution. The *content* of the file (which models,
which prices) is data work that follows the format decision, partly covered by
ticket 08.

---

## Resolution

**Resolved 2026-07-22.** Six decisions. Three of the ticket's bullets were
already locked by prior tickets (units by 02 #3; entry shape by 01's canonical
keys + 05's tier fields; loading timing is mechanical) — recorded here for
completeness, not re-decided. The three genuinely open forks — the JSON-vs-edit
conflict, the failure mode on a malformed entry, and the idempotency mechanism —
are decided below.

The decisive framing for the first two: the bundled JSON is a **curated,
reviewed release asset** (not user input), and apo's `__global__` namespace is
**both** the defaults bucket **and** API-editable today. That overlap is the
real bug; resolving it the langfuse way (one namespace owns defaults, edits live
elsewhere) is the architecturally correct answer.

1. **`__global__` ownership — JSON is the sole source of truth (langfuse-aligned).**
   The bundled file is re-applied idempotently on every startup and is the
   authority for `__global__`. User customization happens **per-project** (apo's
   existing override path, ticket 02 #6), never by editing a global. The sharp
   consequence, made explicit: a global model absent from the JSON is **deleted**
   on next restart, and an edited global price is **reverted** — this is the
   intended behavior (langfuse deletes DB rows not in the file). Globals stay
   reproducible, and a release's price fixes reach every deploy automatically.

   This resolves the conflict the ticket raised (options a/b/c) by ruling out
   the "JSON writes once / versioned merge" alternatives. It does **not**
   re-litigate locked decision 4 (idempotent startup load) — it sharpens *what*
   idempotent means: full reconciliation toward the JSON, not seed-once.

   **Downstream constraint for ticket 10 (API):** the global-write path
   (`POST /api/v1/models` targeting `__global__`) must stop accepting global
   targets. Globals become read-only-via-JSON; the API returns a clear error
   pointing users to per-project overrides. Per-project writes are unaffected.
   This is an API-surface decision owned by ticket 10; recorded here as the
   hand-off so 10 has the contract.

2. **Failure mode on a malformed bundled file — fail hard (crash startup).**
   Reject the file and refuse to boot rather than silently running a partial
   price table. Rationale: a partial table makes some models price as null
   (unpriced) at ingestion — indistinguishable from "model not yet supported,"
   which is exactly the silent-underpricing risk ticket 05 rejected at the tier
   level. For money data in a curated release asset, fail loud; the bug surfaces
   immediately instead of corrupting cost records until someone notices.
   (langfuse's catch-log-and-load-nothing is arguably worst-of-both: server
   boots with an empty price table and no models priced — apo makes it a hard
   failure instead.)

3. **Pricing units in the file — per-1M USD, human-readable (locked by 02 #3,
   recorded here).** Entries use apo's existing convention (`"input": 2.50`),
   the same units every provider publishes in. Converted to INTEGER micro-USD-
   per-million-tokens at load (`$2.50/MTok → 2_500_000`). Rejected: langfuse's
   per-token scientific notation (`2.5e-06`) — avoids scaling bugs but is
   unreadable and error-prone to hand-edit; apo's per-1M is the right call for
   a hand-maintained file, and the load-time conversion eliminates the
   precision concern (ticket 06 rounds per-dimension to micro-USD int).

4. **Entry shape — apo-minimal, keyed to apo's canonical model (locked by 01
   + 05, recorded here).** Top level: a JSON **array** of model objects, each
   carrying `modelName`, `matchPattern` (anchored regex), `provider`, optional
   `startDate` (time-window era boundary, per ticket 04), and a `pricingTiers[]`
   array. Each tier: `name`, `isDefault` (bool), `priority` (int), `conditions`
   (array of `{keys: [canonical_key,…], operator, threshold}` per ticket 05 —
   note apo's condition shape, **not** langfuse's `{usageDetailPattern, operator,
   value, caseSensitive}`), and `prices: {usage_key → per-1M USD}`. Price keys
   are ticket 01's 6 canonical keys (`input`, `cache_read`, `cache_write_5m`,
   `cache_write_1h`, `output`, `reasoning`) — **not** langfuse's freeform set
   (`input_cached_tokens`, `thoughtsTokenCount`, etc.), because apo's normalizer
   (ticket 03) has already mapped provider keys to canonical ones by the time
   pricing is consulted. Tokenizer fields (`tokenizerId`, `tokenizerConfig`)
   are omitted — tokenization fallback is out of scope (map's Out of scope).

5. **Loading timing — replaces `seed_default_models` in `init_db`, once per
   process startup (mechanical, recorded here).** `init_db` (`backend/apo/db.py`)
   currently calls `seed_default_models` after `create_all` + `_run_migrations`;
   the new loader replaces that call, runs after migrations so the 3-table
   schema (ticket 02) exists, and performs full reconciliation toward the JSON
   (upsert present, delete absent) scoped to `__global__`. Per-project rows are
   never touched (namespacing is the protection, per decision 1).

6. **Idempotency mechanism — per-model `updatedAt` (langfuse's design).** Each
   JSON entry carries an ISO `updatedAt`; the loader stores it on the model row
   (pinned from the JSON, **not** `now()`, exactly as langfuse does — otherwise
   the equality check breaks on the next boot) and does exact-equality vs the DB
   row before writing. A no-op restart runs one SELECT up front, finds every
   model already current, and writes nothing. Rejected alternatives: per-model
   content hash (self-maintaining, removes the "forgot to bump" footgun) and
   whole-file version (coarse, same footgun). The hash is the better mechanism
   in isolation, but `updatedAt` is proven at langfuse's scale and keeps the
   file human-auditable ("when was this price last checked"). The bump-discipline
   footgun is real and is exactly what ticket 08's maintenance workflow must
   address (a PR-time check / linter that fails if an edited entry's `updatedAt`
   wasn't bumped is the obvious mitigation — handed off to 08).

### Hands off to

- **Ticket 08** (maintenance workflow): owns the `updatedAt` bump-discipline
  problem (a linter/check that fails the PR if an edited entry didn't bump its
  `updatedAt`), the staleness signal, sourcing workflow, and review gate.
  Unblocked by this resolution. The validation rules it leans on are settled
  here and in ticket 05 — 08 decides process, not rules.
- **Ticket 10** (API surface): the `__global__` write path must reject global
  targets and point users to per-project overrides (decision 1). Read paths for
  globals stay. Per-project CRUD is unaffected.
- **Ticket 09** (migration): already closed; this resolution is consistent with
  it — the migration moves apo's current `DEFAULT_MODELS` Python list into the
  JSON file's initial content.

### Out of scope for this ticket

- The *content* of the file (which models, which prices) — data work, ticket 08
  and ongoing maintenance.
- The `updatedAt` bump-enforcement mechanism itself — process/tooling, ticket 08.
- Specific API error messages / HTTP status for rejected global writes —
  ticket 10.
- Wheel `package-data` / sdist inclusion config — apo runs from source via
  `uv run` today; if it later ships as an installed wheel, a one-line
  `package-data` entry is added then (not a decision the map needs now).
