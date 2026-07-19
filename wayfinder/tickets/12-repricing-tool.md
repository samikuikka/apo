# 12 — Re-pricing tool

**Type**: Grilling (HITL) · **Status**: open · **Claimed by**: cost-session-12 · **Blocked by**: 06, 09

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
