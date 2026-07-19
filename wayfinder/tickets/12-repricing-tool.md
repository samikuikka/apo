# 12 — Re-pricing tool

**Type**: Grilling (HITL) · **Status**: closed · **Claimed by**: cost-session-12 · **Blocked by**: 06, 09

## Question

How does a user recompute historical cost after fixing a wrong price or asking
"what would this cost at today's prices"?

Locked decision 2 (history): cost is frozen at ingestion; a re-pricing tool
recomputes on demand. This ticket decides what that tool is.

### Context

No equivalent in langfuse's default product surface — they recompute on read
implicitly. apo chose frozen-at-ingestion explicitly, so re-pricing is apo's
own tool to design.

apo's closest existing thing is `POST /api/v1/models/seed-defaults`, which
re-seeds prices but doesn't touch historical calls.

### To decide

- **Trigger**: CLI command (`apo reprice …`), dashboard button, API endpoint,
  or all three? CLI is apo's strength and matches the "deliberate operation"
  framing; dashboard button risks accidental clicks.
- **Scope selector**: reprice everything, by project, by model, by time range,
  by call set? A `--model` / `--since` / `--project` flag set.
- **Destructiveness**: does re-pricing overwrite the frozen cost in place, or
  write a new "re-priced cost" alongside (preserving the original frozen value)?
  Preserving-original is safer (the frozen value is the historical record); but
  then the dashboard has two numbers — "frozen" vs "re-priced" — and the user
  must pick which to view. Coupled to ticket 11's display question.
- **Idempotency / dry-run**: `--dry-run` to preview the diff before applying?
  Strongly recommended for a destructive history rewrite.
- **Performance**: repricing millions of calls. Batched? Background job?
  Streamed progress? apo is SQLite single-binary — no background worker infra
  today. Decide whether it runs inline (blocking) or needs a job mechanism.
- **What gets repriced**: only calls with stored usage maps can be truely
  repriced. Old calls without usage maps (pre-migration, see ticket 09) can't —
  the tool should report them as "skipped, no usage" rather than silently
  leaving them.

### Scope

Decides the tool's trigger, scope selector, destructiveness semantics, and
performance shape. CLI help-text sync (per AGENTS.md) is implementation detail.

---

## Resolution

**Resolved 2026-07-22.** The destructiveness question is the root; trigger,
scope, and performance branch from it. All four settled here so the spec writer
has the full re-pricing contract.

### 1. Destructiveness — overwrite in place, `--dry-run` is the safety path

The frozen cost column is overwritten in place; no parallel "re-priced cost"
column is introduced.

Reading locked decision 2 ("cost is frozen at ingestion — a January call stays
at January's rate") literally would forbid overwrite, but the ticket's primary
use case is "after fixing a wrong price" — a typo'd JSON entry froze a value
that was *wrong*, not "what was actually paid." Re-pricing corrects the derived
cost toward reality. Reconciliation: **"frozen" means "not recomputed on every
read," not "immutable against explicit operator action."** The frozen value is
the stable default *between* re-pricings; a deliberate re-price is the sanctioned
exception — the sole retroactive path (ticket 06 hand-off, restated).

Three reasons overwrite beats a second column:

1. **`raw_usage` is never touched** (ticket 06 decision). Re-pricing changes only
   the derived cost; the source usage data is immutable. The cost is always
   recomputable from `(raw_usage, current prices/tiers)`, so overwriting the
   derived value is not destructive to source data.
2. **Single source of truth.** A parallel "re-priced cost" column forces every
   aggregation (`trace_backend.aggregate_costs`, `metrics/aggregate.py`,
   `runs/metrics.py`) to pick a number, and ticket 11's dashboard to show two
   numbers and ask which to view — re-creating the `cost`/`calculated_cost` split
   ticket 06 just collapsed. One effective total stays one effective total.
3. **"What would this cost today" is served by `--dry-run`**, not persistent
   duplicate storage. Recompute against current prices, preview the diff, decide
   whether to apply. No permanent second column needed.

What overwrite loses — the pre-reprice value — is reconstructable (cost is a
pure function of `raw_usage` + time-windowed prices, ticket 04) and not what the
operator running a corrective re-price wants to see anyway.

### 2. Trigger — CLI command only (no API endpoint, no dashboard button)

`apo reprice …` is the sole trigger. No `POST /api/v1/.../reprice` endpoint and
no dashboard button in v1.

- **CLI is apo's strength** and matches the "deliberate operation" framing —
  re-pricing rewrites historical cost; it should require intent, not a click.
  A dashboard button invites accidental invocation on a destructive operation.
- **`reproject.py`** is a backend-only service (no CLI surface today) — the
  precedent cuts the other way: the existing replay tool is API-only and
  underused because no CLI drives it. The cost system's re-pricing tool ships
  CLI-first to avoid that.
- **Why no API endpoint in v1**: the CLI's `apiPost` has a 15s HTTP timeout
  (`lib/api.ts:16`), and re-pricing is potentially long-running (see §4). Rather
  than expose an endpoint whose timeouts and progress reporting the CLI must
  paper over, the CLI talks to the DB the same way the retention loop and
  scheduler do (backend services, not HTTP). *The CLI command may share the
  backend service function* that computes and applies the reprice — it just
  doesn't go through an HTTP route. An API endpoint can graduate from fog if a
  later product need (e.g. a "reprice this project" dashboard action) arises.
- This **resolves the map's CLI-surface fog** for the re-pricing piece: the
  re-pricing CLI command *is* the CLI surface; no separate ticket needed.

### 3. Scope selector — project + time-range + model, all optional, AND-combined

```
apo reprice [--project <id>] [--model <match_pattern>] [--since <datetime>] [--until <datetime>] [--dry-run]
```

- All filters optional; omitting all reprices every repricable call in the DB.
  Reprice-everything is valid and is the "I fixed the global JSON, recompute all"
  case.
- **AND-combined** — `--project foo --model gpt-4o` reprices only `foo`'s
  `gpt-4o` calls. No OR.
- **`--since`/`--until`** bound `call.start_time` (the window key, ticket 04)
  — half-open `[since, until)`, matching the time-window semantics so an operator
  can reprice exactly "calls from the mispriced week."
- **`--model`** matches against the model-era's `match_pattern` (ticket 02/04),
  i.e. it selects by the model the call was *priced against* (`internal_model_id`),
  not the raw model string. This lets an operator target "everything priced by
  the misconfigured model row."
- No `--call-set` / arbitrary ID list in v1 — the four flags cover the realistic
  corrective scenarios (wrong global price, wrong project override, wrong time
  window).

### 4. Performance — streamed batching with inline progress, no background job

Re-pricing runs **inline** (blocking the CLI until done), processing calls in
**streamed batches** with progress printed to stderr. No background job, no job
table, no separate worker.

- **Why inline over a background job**: apo has no job framework (no Celery/RQ —
  the `TraceIngestionQueue` is DB-backed and ingestion-specific). Building a job
  table + worker + progress-poll protocol for one corrective operation is
  out-of-proportion engineering. The operator invoking `apo reprice` is watching
  the terminal; inline-with-progress is the honest UX.
- **Why it's tractable inline**: a re-price is a pure read-recompute-write over
  `raw_usage` + current prices/tiers — no span replay, no canonical-store
  lookup (unlike `reproject.py`). Streamed batches (`SELECT … WHERE … LIMIT N
  OFFSET k` or keyset pagination) + per-batch `commit` keep memory bounded and
  give natural progress ticks ("repriced 10,000 / ~50,000 calls").
- **Idempotent and resumable**: a batch committed before a crash stays repriced;
  re-running `apo reprice` with the same flags picks up where it left off
  (already-correct calls recompute to the same value). No two-phase fencing
  needed.
- **Large datasets**: the streamed-batch + commit-per-batch shape means even
  millions of calls complete without an OOM and without holding one giant
  transaction. If a dataset is so large the operator won't wait, they scope with
  `--since/--until`/`--project` — the tool doesn't need to invent async for them.
- **Dry-run is the same loop without the write** (`--dry-run`): computes the
  reprice, prints a summary (N calls would change, total delta ±$X, M calls
  skipped-no-usage), commits nothing.

### 5. What gets repriced, and how — re-derive from raw_usage, report skips

**The recompute** reads each call's `raw_usage` (ticket 06: the normalized usage
map), resolves the model-era + tier against `call.start_time` (ticket 04/05
resolution order: model-era → tier → prices), and recomputes via the **same
compute function** used at ingestion (`breakdown[k] = tier_prices[k] ×
raw_usage[k]`, round-per-dimension, total = sum). The provenance flag flips to
`computed` (the provided path is not re-invoked — see §6).

**Skip rules** (reported in the summary, never silently dropped):

- **No `raw_usage`** (pre-migration calls per ticket 09): `cost_breakdown`/
  `raw_usage` are null. These cannot be repriced. The tool counts and reports
  them as "skipped — no usage map (pre-migration)." This is the documented seam
  from ticket 09: history before migration keeps its scalar total, gaining no
  breakdown and no re-price.
- **No matching model-era at `call.start_time`**: the call stays unpriced
  (cost/breakdown null, `raw_usage` retained) — matches ticket 06 failure-mode 1.
  Reported as "skipped — no matching model."
- **Matching model, key in usage but unpriced**: skip the key (contributes 0),
  keep it in `raw_usage` — matches ticket 06 failure-mode 2. Not a skip of the
  call, just of that dimension.

**The aggregation downstream stays coherent** because `cost` is the single
effective total (ticket 09): overwriting it means every SUM query reflects the
reprice immediately. Run/session rollups (`AgentTaskRunDB.total_cost`,
`RunMetricDB`) are *not* automatically refreshed by a per-call reprice — the
spec must decide whether re-pricing recomputes the affected rollups or leaves
them for the next aggregation pass. Recommendation for the spec: recompute
rollups for affected runs/sessions at the end of the reprice (same batched
loop, reusing `aggregate_costs`/`calculate_and_store_aggregate_metrics`), since
a reprice that updates per-call cost but leaves stale rollups would re-introduce
exactly the incoherence the system is designed to prevent.

### 6. Provided-cost calls — re-pricing does not override an SDK-provided cost

A call whose cost was **provided** by the SDK (provenance = `provided`, ticket 06)
is **skipped by re-pricing**, not overwritten. Rationale: the SDK-supplied cost
is authoritative for that call (the provider told us what it cost); re-deriving
from `raw_usage` + our price tables would *replace* the provider's number with
our estimate — the opposite of "provided wins verbatim."

The two valid re-pricing targets are calls with provenance `computed` and a
non-null `raw_usage`. (The "fix a wrong price" use case is always a `computed`
call — a provided cost isn't affected by our price tables being wrong.)

If an operator wants to force-reprice even provided calls (e.g. the provider's
own number was wrong), that's a `--include-provided` escape hatch — deferred to
the spec as a flag, defaulting off. Recorded in fog below.

### 7. Summary output — counts and delta, to stdout

On completion (or dry-run), the command prints a summary:

```
Repriced 12,437 calls (+$1,203.44 / -$284.11 net delta).
Skipped: 3,201 (no usage map — pre-migration), 14 (no matching model).
Rollups refreshed: 87 runs, 12 sessions.
```

`--json` (the CLI's existing global flag) emits the same fields as a JSON object
for scripting. Net delta is the sum of (new_cost − old_cost) over repriced calls,
for quick sanity ("the reprice moved totals by roughly what I expected").

### Out of scope for this ticket

- The spec-level reprice-function signature, batch size, and exact SQL — spec work.
- A `--include-provided` force flag (recorded in fog).
- An HTTP API endpoint / dashboard button (graduates from fog if a product need
  demands a UI trigger; the CLI is the v1 surface).
- Automatic recompute of run/session rollups — recommended above, but the
  spec-level decision (recompute-rollups vs leave-for-next-pass) lands in the spec.

### Hands off to

- **Ticket 11** (dashboard): no second cost column means no "frozen vs re-priced"
  toggle in the UI. A re-priced call looks like any other call — its cost is
  simply correct. A "last repriced at" indicator is optional and couples to
  ticket 08's staleness signal, not required by this decision.
- **Ticket 13** (testing): the recompute function is the seam — it's the same
  compute used at ingestion, so its tests already cover the math. Re-price
  earns its own tests for the *scope/skip* logic (pre-migration skip, no-match
  skip, provided-skip, AND-combined filters) and the *rollup refresh* path.
- **Spec writer**: the `apo reprice` CLI command follows the standard command
  recipe (new `commands/reprice.ts`, register in `main.ts` with help/args/
  options/examples per AGENTS.md CLI section). It calls a backend
  `services/reprice.py` service function (mirroring `reproject.py`'s shape),
  *not* an HTTP endpoint.

### Newly specified fog (for the map)

- **`--include-provided` force flag.** Whether to ship an escape hatch that
  overrides the provided-cost skip (default off). Now specifiable as a small
  follow-up decision, but not blocking — defaults to "no flag, provided calls
  are always skipped." Low priority.
