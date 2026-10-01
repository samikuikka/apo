# Monitors page — UI prototype

**Question**: What should apo's Monitors page look like? (Inspired by respan's
monitors: `When [metric] of spans [op] [threshold] over [window]` + `Where`
filters + notification destinations + a live alert preview in the editor.)

**Route**: `/project/<id>/monitors-prototype?monitor=A|B|C` — arrow keys flip
variants; a floating bar at the bottom cycles them. (`?monitor=`, not
`?variant=` — the shell's status-bar prototype from a parallel session owns
that param; on this page our key handler claims the arrow keys so only the
monitors switcher flips.) Read-only: monitors are
fixtures, but their series, current values, and fired alerts are computed from
the project's **real batch runs** (last 60), so numbers like the 19% pass rate
are genuine.

**What a monitor means in apo** (vs. today's Automations): Automations are
instantaneous event matchers — a run event arrives, conditions on that single
event are checked, an action fires. A *monitor* evaluates a **windowed
aggregate** — pass rate / failed tasks / errored tasks / cost / duration over
1h–7d — and fires when a threshold is crossed. Same delivery machinery
(Slack/email/webhook/GitHub issue, HMAC signing, consecutive-failure health),
new evaluator.

## Variants

- **A — Trigger builder** (respan-faithful): sentence-shaped editor
  (`When Pass rate of task runs is < 80% over 24h`) + Where rows + Send-to
  destinations + **live alert preview** with sample data, updating as you
  edit. Monitor list below.
- **B — Status board**: the board is the page — one dense row per monitor with
  an evaluation sparkline, dashed threshold line, red breach markers, current
  vs threshold in mono numbers.
- **C — Alert inbox**: responder-first — left rail of monitors, main column a
  chronological alert feed derived from real breaching runs, each linking to
  the actual run; active breaches pinned.

## Verdict

- **Round 1 feedback (user)**: variant A crammed the editor and the monitor
  list onto one page — "too much info". respan separates browsing (list page)
  from creating/editing (dedicated editor surface). A is now two views: a
  list with state filter chips + rows, and a full-page editor reached by row
  click or "New Monitor" (blank monitor, deploy gated on a destination).
- **Round 2 feedback (user, with respan's create screen)**: "they have
  something like this, why ours so complex" — respan's create is a centered
  card: name + a grid of plain metric presets; the dense editor only opens
  after the pick, prefilled. A's create flow now matches: New Automation →
  preset picker (name + What should it watch) → editor prefilled with
  per-metric defaults (threshold, operator).
- **Round 3 feedback (user)**: (a) "we lost our create monitor" — the create
  flow dead-ended: deploying a new automation never landed it in the list.
  List and create must work together like respan's two pages: Deploy now adds
  the automation to the list and returns there. (b) **Naming: apo calls this
  concept Automations, not monitors** — all user-facing copy renamed
  (Automations / New Automation / Create a new automation). Note for the real
  implementation: these are windowed/aggregating automations — the existing
  automations are instant event matchers, so the model gains a trigger kind
  (per-event vs windowed-threshold), not a separate feature name.
- **Round 4 feedback (user)**: disliked the separate preset-picker page
  ("name + what should it watch" on its own screen) — wanted **one page with
  all the info**. Merged: the editor is now the single create/edit surface —
  name input in the header, "What should it watch?" preset grid as the first
  section, trigger/where/destinations/preview below. "New Automation" opens
  it directly; no wizard step, no Continue button.
- **Round 5 feedback (user)**: the metric belongs **inside the "When"
  sentence as a dropdown** (respan: "When [Count] of [spans] ≥ 0 over 5m"),
  not as a preset grid section above it. Removed the "What should it watch?"
  grid; the trigger row is again `When [metric ▾] of [task runs ▾] is [op ▾]
  [threshold] over [window ▾]`. Converged editor shape: name input in the
  header + one trigger sentence + Where + Notifications + live preview.
- **Round 6 feedback (user)**: respan's When-dropdown is a **grouped metric
  tree** — categories like Count / Errors / Tokens / Cost / Latency that open
  to reveal children (error count, error rate; peak/total cost…). Built the
  apo equivalent, all computable from real batch-run fields: Pass rate
  (suite, checks) · Failures (failed tasks, failed checks) · Errors (errored
  tasks, error rate) · Cost (total, average, peak) · Latency (average, peak,
  P95) · Tokens (total, reasoning). Categories expand/collapse in the
  dropdown; selecting a child auto-expands its category.
- **Round 7 feedback (user)**: "Send Test Alert" doesn't belong as a
  top-level editor action. Kept the capability (the existing automations
  API already ships `POST /automations/{id}/test`; a dead destination is
  the #1 silent alerting failure) but moved it into the Notifications
  section beside the destinations it verifies, with its result note
  inline.

_(pending — which variant (or mix) wins overall; then delete this directory
and fold the winner into a real `/automations` evolution)_

## Capability audit — mock vs. what apo can actually do

Audited 2026-10-01 against the real backend, so the mock never shows
something apo can't implement.

**Real today (fields/behavior verified in code):**

- All 14 metrics compute from existing batch/task-run fields:
  `passed_tasks/total_tasks`, `passed_checks/total_checks`,
  `failed_tasks`, `total_checks-passed_checks`, `errored_tasks`,
  `total_cost`, `total_tokens`, `total_reasoning_tokens`,
  `started_at/completed_at`, `total_model_time_ms`.
- Where filters: `task` (task-run `task_id`), `model` (`configured_model`,
  already a runs-page filter), `provider` (serving host, runs-page filter,
  issue #307), `environment` (batch field), `trigger.source` (automations
  resolve it from `run_metadata` today).
- Windows: the runs API already takes `since` (`1h…30d`).
- Channels: **Slack / webhook / GitHub issue** — the exact action
  vocabulary `services/automations.py` implements (HMAC signing, encrypted
  credentials, health auto-disable all shared).
- Send Test Alert: `POST /v1/automations/{id}/test` exists today.
- Alert history: `AutomationExecutionDB` already records every firing
  (input/output/status) — the variant C feed maps onto it.

**Not today — the actual new work (feasible, sized):**

- The **windowed evaluator** itself: automations are per-event matchers;
  a scheduler thread (pattern: `agent_task_scheduler.py`) that computes
  window aggregates and compares thresholds is the core new backend piece,
  plus re-arm/cooldown semantics.
- ~~Email channel~~ — removed from the mock (was shown in early rounds):
  automations don't deliver email today. The `EmailService` exists for
  auth/invites, so wiring it in is small, but the mock must not offer it.
- ~~`judge = second-opinion` filter~~ — removed: runs carry no judge
  field; judge monitoring would need `AgentTaskJudgmentDB` joins. Future
  extension, not current capability. (Draft fixture now uses a real
  `task contains …` filter.)
- Acknowledge / Mute-all (variant C): trivial CRUD once fires are rows;
  no infrastructure for it yet.

## Backend implications if this becomes real

- `MonitorDB`: trigger (metric, operator, threshold, window), where filters,
  channels, lifecycle (draft/deployed/paused), last evaluation, health.
- Evaluator: scheduler thread à la `agent_task_scheduler.py`, every ~5m
  computes `compute_run_stats`-style aggregates per monitor window and
  compares — needs re-arm/cooldown semantics (a windowed threshold stays
  breached for many ticks; respan explicitly notes window ≠ cooldown).
- Delivery: reuse automations actions + `webhook_delivery` health policy; add
  the email channel via the existing `EmailService`.
