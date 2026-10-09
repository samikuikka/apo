# Tasks page empty states — UI prototype

**Question (round 1)**: What should the Tasks page show when there is nothing
to show — especially when the project is *not actually empty*?
`company-traces` has 0 published tasks / 0 recorded runs yet **11 real traces
from `billing-api`** flow in, while the page claims "empty, and yours".

**Question (round 2)**: *Reactive won — now do it well.* Three implementations
of the reactive onboarding, aimed at first-time customers.

**Question (round 4 — the positioning)**: agents should do most of the work.
The user's wish: apo's gift to a new user is *one prompt* — paste it into
your coding agent, everything gets set up. The empty page's job is to hand
over that prompt (project-aware) and watch it happen. A1 was reworked
agent-first accordingly.

**Question (round 5 — the bridge)**: "why does the user carry all the info?
why can't the agent fetch it itself? why copy-paste?" The physics: the
browser session (project + keys) and the repo (agent's world) are
disconnected, so *something* crosses once — but the user shouldn't be the
mule. Redesign: the paste shrinks to **one line containing a single-use
setup URL**; the agent fetches that URL and receives server + project + a
key minted at fetch time + the method pointer (`start.md`). No server URLs
or key material in the paste; nothing reusable left in the transcript.

**Question (round 6 — the simplification)**: "why not something like my
docs page — a button that copies the prompt, and the agent handles it?"
Correct: rounds 4–5 solved the *auth* moment before shipping the *core*
interaction. The docs' `CopyPromptButton` pattern is the right v1 — one
button, the prompt already knows this user's server + project (the one
thing the docs button can't), auth in v1 is the CLI's existing interactive
login (agent runs it, human types credentials once). **Zero new backend.**
The auth refinements become an evolution ladder, not a prerequisite:

1. **v1 (this)**: copy prompt; agent follows start.md; `apo login` interactive, once.
2. Key-in-prompt: "Generate Setup Key" mints a 24h `sk-…` (endpoint exists) —
   no password moment, key rides in the paste.
3. One-time setup link: single-use URL, key minted at fetch — nothing
   reusable in the transcript (needs the setup endpoint).
4. Endgame — browser-approval login: `apo login` opens the dashboard,
   member clicks Approve, CLI receives the key. Zero paste, zero secrets.

**Question (round 8 — the duplicate prompt)**: "do I need the prompt
twice — the button and the visible text? that text is agent-speak; humans
get the manual commands." Correct: the always-visible `<pre>` is gone.
The handoff is now exactly the docs hero pattern — compact **Copy Prompt
For Your Agent** button; the prompt appears only as a hover/focus tooltip
below the button ("The prompt your agent receives: …"); click copies and
morphs to "Copied — Paste Into Your Coding Agent". Humans doing the work
themselves use the collapsed "Prefer doing it yourself?" section.

**Question (round 7 — the watching)**: "not good engineering, trying to
watch like that — we need to think the flow." Rejected the 5s polling.
The real flow: the user pastes the prompt, then watches their *agent*
(the logs are there, not here); they return to this page when the agent
reports done. So the page is **correct on arrival** — signals read once on
mount and again on tab focus (`visibilitychange`), never on a timer.
Onboarding state changes a handful of times in a project's life; holding
an interval (or an SSE subscription) open for it is traffic without an
audience. Live updates remain where they belong: the Runs pages, via the
existing `useRunEvents` stream (mid-run watching is real there). The
"Checking every 5s" microcopy, live-flash celebration, and waiting
language are all gone; the timeline is a state summary. Verified: 1 fetch
on mount (2 in dev — StrictMode double-effect), exactly +1 per refocus,
zero background traffic.

## Round 12 — the live-agent proof (2026-10-21)

A real subagent (not a human typing commands) received ONLY the page's
handoff prompt for a brand-new project (`agent-proof-live`, 3882e22e4d36)
+ the one credential reply. Result: task authored, published, and run
recorded — **PASS 3/3 checks, zero model cost, ~9 min** — while a watcher
polled the real derivations and screenshotted the page at each flip:
18:43:58 cli_keys=1 → 18:48:03 published=1 → 18:48:15 recorded=1.
Screenshots: live-1..4 in the session visualizations dir.

**Critical-path bug found & fixed**: `apo login --project X` silently
ignored the flag when a remembered key for the backend was valid but
bound to a DIFFERENT project — login "succeeded", every later command
403'd. The agent diagnosed it through the DB and self-recovered via
`POST /v1/api-keys/bootstrap`. Fix (in-tree): both login fast paths now
probe `/v1/projects` with the saved key and fall through to password
re-auth (which mints the right key) when the requested project isn't
visible; 2 regression tests added (login-switch.test.ts); 654 CLI tests
green; live-replayed: guard fires, key minted for the correct project.
NOTE: the `apo` shim on PATH points at `.worktrees/apo-main` (clean
main), so the fix reaches users when it lands on main.

Other agent findings for the ship list: login guesses a task root inside
the host repo when run from there (guide should tell agents to run login
from their work dir); eval files need `"type": "module"` in package.json
(start.md gap); `apo task publish` prints a cached digest on republish.

**Regression coverage added**: backend `test_onboarding_status.py` +3
tests (has_cli_key scope-sensitivity, trace_count/latest_trace_service)
— 8/8 pass. The projection is now contract-tested end to end.

## Round 11 — continuity over real estate

User verdict on the story: "the view changes too much — the checks don't
go green and stay visible; the whole UI changes; hard to understand."
Diagnosis: the mid-journey panel→banner swap (and the story's per-beat
remounts) destroyed the checklist's continuity — the one property that
makes onboarding checklists legible (GitHub/Stripe/Sentry all keep one
stable card; items flip in place; the card leaves only when finished).
Fixed in the real design (A1 dropped the banner transformation; glyphs
transition in place) and the story now renders one persistent surface —
verified: same timeline all 5 beats, greens 0→1→2→4, list fades in below,
success lands inside the last step.

## Round 10 — the story walkthrough

`?empty=S` — a clickable/auto-playing demo of the entire arc: the real A1
surface in a browser frame (scripted signals, same components), 5 beats
with play/pause/prev/next + clickable dots, captions narrating who acts
(YOU twice: paste + password; everything else AGENT/PAGE). A simulated
agent-terminal panel existed briefly and was removed on user feedback —
the page and its captions carry the story alone. Animations are CSS-only, wrapped in
`prefers-reduced-motion: no-preference` (state-motion timing per
design.md; this is a concept demo, where illustrative motion is
sanctioned). Proven against the real flow in round 9's end-to-end test —
the script mirrors what actually happened.

## The mechanism — engineering design (round 9)

**How the checks work.** There is no checklist state anywhere. Each step is
*derived on read* from authoritative domain rows:

| Step | Derivation (SQL, on read) |
|---|---|
| Signal Is Flowing | `count(RunDB where project) > 0` (+ latest `service_name`) |
| Connect The CLI | `count(ApiKeyDB where project, scope="full") > 0` — exactly what `apo login` mints |
| Publish A Task Suite | `count(ProjectTaskInventoryDB where project) > 0` |
| Record A Run | `count(AgentTaskRunDB join BatchRun where project) > 0` |

One endpoint (`GET /v1/projects/{id}/onboarding-status`) returns all of
them; the step list is a pure function of that projection
(`buildJourney(signals)` — first incomplete = active). The panel is
correct on arrival: server-rendered derivation + refetch on tab focus. No
polling, no SSE, no writes anywhere.

**Why derived, not stored** (the industry split, researched):

- *Stored checklist state* — Sentry's `organizationonboardingtasks`
  (readable in their open source): event handlers write task rows when
  signals arrive. Pros: audit trail, cheap reads, "completed_at"
  timestamps. Cons: drift — their tracker's own bugs are stored/derived
  mismatches (quick-start tasks not completing; a checklist showing "5 of
  6" where the 6th is *impossible* to complete).
- *Derived projection* — Stripe's pattern (Connect completion is the
  Account's current `requirements`/`capabilities`, not a flag): completion
  computed from authoritative state. Cannot drift, regresses honestly,
  zero writes; costs a read (trivial at apo's scale — four counts).
- apo picks **derived**, decisively: the first-run *gate* already derives
  (`published==0 && recorded==0`); a stored checklist would create a second
  source of truth for "is this project onboarded" and eventually disagree
  with the gate. We also inherit the corollaries: **never render a step
  whose signal can't be detected** (Sentry's impossible-6th-task bug), and
  **no dismiss button** — the panel *is* the empty state, so there is
  nothing to dismiss it out of the way of.

**Semantics decisions:**

- **Regression is honest.** Revoke the only full-scope key → the CLI step
  reopens. Derived state shows current truth; a stored "done" would lie.
- **Gate = `recorded_run_count == 0`.** The journey is "get to your first
  verdict", so the surface lives until a run is recorded, then never
  returns. Publishing alone no longer hides it (today's gate closes on
  publish *or* run — half-finished onboarding would lose its map).
- **One stable surface (round 11 revision).** The earlier two-density
  idea (panel → banner above the list) optimized real estate but broke
  continuity — the layout swapped mid-journey and progress became
  illegible ("the checks don't go green and stay visible"). Revised: the
  checklist keeps its exact shape from virgin to done. Steps flip green
  in place (CSS color transition, no remount), the task list grows
  beneath it, the success moment appears inside the final step, and only
  completion ends the surface (the gate drops it on the next visit).
  Same derivation, zero mid-journey layout changes.
- **Auth of the projection.** `has_cli_key` is a boolean in the
  member-scoped projection — members see their own progress without
  key-enumeration rights (listing keys is admin-only). No key material, no
  prefixes, one bit.
- **Old-backend compat.** New fields are optional in the TS type; the
  client falls back to the admin key-list probe when `has_cli_key` is
  absent (members on old backends see the step as pending — honest).

**Fold-in checklist** (what the real implementation inherits): backend
change is *already done in-tree* (`has_cli_key` + `trace_count` +
`latest_trace_service` added to `onboarding-status`, basedpyright clean);
remaining is the frontend rewrite into `ProjectFirstRun`'s slot with
tests (derivation unit tests on `buildJourney`, a11y pass), and the
start.md Path-A paragraph.

## Audit — what we have / what needs to happen (2026-10-18)

**Already built, agent-first infrastructure in the docs:**

- `/start.md` (`apps/docs/src/pages/start.md.ts`) — a complete agent-readable
  setup *skill*: interpretation contract, mental model, discover → connect
  (Path A existing server / Path B self-host) → adapter → task → publish →
  run, with deeper docs linked as `.md`. The landing hero's Copy Prompt
  button copies `"Read <site>/start.md then help me set up apo…"`.
- `/llms.txt` + per-page `.md` renditions — agent-discovery index.
- `CopyPromptButton.astro` / `CopyPrompt.astro` — the copy-prompt UI bits.
- Backend: `POST /v1/api-keys` with `expires_at` (mint 24h `scope="full"`
  key; secret shown once), Bearer `sk-…` accepted, revoke endpoint exists.
- CLI: `APO_API_KEY` env auth (no login needed), `apo login --email
  --password` non-interactive fallback.
- start.md **already expects this page**: "Invited to a hosted apo? Your
  Project's Tasks page shows the exact `apo login` command to copy."

**The gap — why the docs handoff alone isn't enough:** the docs prompt is
*generic* (no server URL, no project, no auth). An invited user's agent
would have to stop and ask. The dashboard empty page is the one surface
that knows all three — its job is the **project-aware handoff**: prompt
embedding backend URL + project + a minted 24h key, pointing at start.md
for the method. That's exactly what A1 now is.

**Needs to happen (small, ordered):**

1. Fold the docs-button A1 into the real first-run slot (`ProjectFirstRun`
   replacement) — rewrite with tests, a11y pass. Signals render
   server-side (the page already fetches `onboarding-status` for the
   gate) + the focus-refresh hook. **Zero backend needed.**
2. `onboarding-status`: add `has_cli_key` (count of `scope="full"` keys) —
   one query; the timeline then detects CLI-connected without members
   needing key-enumeration rights.
3. start.md tweak: Path A should say "open your project's Tasks page and
   press Copy Prompt — it already knows your server and project".
4. Auth ladder when wanted: key-in-prompt (endpoint exists) → setup link
   (one new endpoint) → browser-approval login (endgame).
5. Optional, only if ever asked for: publish/catalog events on the
   existing SSE stream — not needed for this page's flow.

**Bridge options compared** (why round 5's shape):

| Bridge | User's paste | Secret in transcript | Backend cost |
|---|---|---|---|
| Key embedded in prompt (round 4) | ~10 lines | yes — reusable 24h key | none |
| **One-time setup URL (round 5)** | **1 line** | no — single-use URL only | one endpoint |
| Browser-approval login (endgame) | nothing (terminal + one click) | no | login-flow endpoints |

**Route**: the real `/project/<id>/tasks?empty=A1|A2|A3&scene=…` — variants
mount inside the genuine project shell, gated so they only replace page-level
empty states (never a real task list, never an error state). Bottom bar flips
variants (←/→) and scenes. `real` = live polling of the project's actual
state; `virgin*` / `published*` / `done*` = fixtures along the arc.

## Round 1 verdict

**Reactive checklist (A) won** — steps that check themselves against real
signals beat the static essay, the live-signal strip (B), minimal canvas (C),
and the aspirational split (D). B's live trace table remains a good ingredient
(kept as the "Signal Is Flowing" pre-step detail); D's destination preview
survives inside A3.

## Round 2 — the reactive onboarding, three ways

**A1 (round 4) is agent-first**: the handoff card (prompt + optional 24h key)
is the single primary action; the timeline is the live watch; manual
commands live collapsed under "Prefer doing it yourself?". A2/A3 keep the
round-2 user-first shape for comparison.

Journey model shared by all three (respan-inspired: tight loop, verify step,
agent-first row):

| Step | Detectable via | Notes |
|---|---|---|
| Signal Is Flowing *(pre-step, only when true)* | `has_traces` + `/v1/runs` count/service | "billing-api · 11 traces" — delight, not a chore |
| 1. Connect The CLI | any `scope="full"` key (`GET /v1/api-keys?project=`) | what `apo login` mints |
| 2. Publish A Task Suite | `published_task_count > 0` | example + demo links |
| 3. Record A Run | `recorded_run_count > 0` | "PASS and FAIL both record evidence" |
| 4. Open The Verdict | run recorded → CTA to Runs | respan's verify step |

- **A1 — Live timeline**: vertical glyph rail, **only the active step
  expanded** (progressive disclosure — pending steps show a one-line hint,
  never their commands), "Checking every 5s — leave this open" microcopy,
  completion flash ("just now" tag + green pulse), success moment
  ("Your first verdict is in → Open The Run").
- **A2 — Compact progress**: the checklist as slim page furniture — done
  chips · active chip with the one command inline · pending chips muted.
  Tests "guide stays out of the way".
- **A3 — Journey + destination**: A1's timeline left; right panel advances
  with the journey: real task-spec teaser (from the example suite) → real
  published task rows → verdict card. "Watch the page fill."

**Verified live** on the dev stack: real scene detects the existing
full-scope key + 11 traces within one poll ("Step 2 of 4 · 2 done"); a
mid-watch key arrival (simulated via route interception — no data mutated)
flashes "Connect The CLI — just now" without a reload.

## Respan patterns adopted (and where they came from)

- **4 tight steps + explicit verify step** ending in the product UI, with
  inline troubleshooting ("Don't see it? …") — their tracing quickstart.
- **Agent-first onboarding**: a copyable "set this up for me" prompt for
  coding agents, collapsed at the bottom (`<details>`).
- **One real working sample** — the spec teaser is a shortened real task from
  `apps/example-service/e2e/agent-task-demo`, not invented copy.
- **Live confirmation** (Sentry's "waiting for events" magic): the panel
  polls every 5s and checks steps off the moment they land.

## Verdict

**Round 2/3 (user): A1 — the live timeline — won.** The agent-first row at
the bottom was then upgraded from a keyless prompt into the full
"hand the whole setup to your coding agent" flow (see below).

## Agent-run setup — "users probably want apo to do that"

**The honest constraint**: the dashboard can never install, publish, or run
anything on the user's machine — apo's own model is that the agent under
test runs on the user's machine. So "apo does it for me" is really "the
user's coding agent does it, and apo hands it everything it needs."

**The flow, all of it working today with zero backend changes:**

1. "Generate Setup Key" → `POST /v1/api-keys` with
   `{name: "agent-setup", scope: "full", expires_at: now+24h}` — endpoint
   exists, returns the `sk-apo-…` secret once.
2. The secret is embedded in a copyable agent prompt:
   install CLI → `export APO_BACKEND_URL/APO_API_KEY` → read docs →
   define one suite → publish → record one run → report back.
3. The CLI already authenticates from `APO_API_KEY` / `--api-key`
   (Bearer `sk-…` is a supported wire format), so the prompt is
   self-contained — the user's password never travels.
4. The timeline's 5s poll checks steps off while the agent works.

**Verified**: mint+revoke via API (200), keyed prompt renders after mint
(stubbed in the preview). Note for the prototype: the preview runs on
:3100, which the backend's origin allowlist correctly rejects for POSTs —
on the installation's real origin the same request succeeds.

**If this becomes real — beyond the zero-work version:**

- A narrower `setup` scope instead of `full` (CLI publish/run currently
  require full scope; a setup scope needs an endpoint scope audit) — or
  keep `full` and lean on the 24h expiry.
- Limit one active setup key per project; surface "revoke" next to the
  success line (delete endpoint exists).
- A hosted `agent-setup` doc page for the prompt to point at (respan does
  exactly this), so the prompt stays short.
- Trust note to ship in copy: the key rides in a prompt pasted into the
  agent — but that agent already has shell access to the user's machine
  (and could read `~/.apo/credentials` anyway); a 24h scoped key is
  strictly safer than the agent handling the account password.

## If this becomes real — implementation plan

- **Signals**: `onboarding-status` already returns everything except
  CLI-connected. Add `has_cli_key` (count of `scope="full"` keys — the same
  query the prototype makes against `/v1/api-keys`, folded in so members
  don't need key-enumeration rights) → one projection, one poll.
- **Polling**: 5s interval while the panel is mounted and incomplete; stop
  when the last step completes (panel unmounts anyway — `firstRunSetup` gate
  closes on `recorded_run_count > 0`).
- **Completion moment**: keep the flash + success state linking to Runs;
  no dismissal affordance (durable emptiness stays the gate, as today).
- **Frontend**: fold the winning variant into `ProjectFirstRun`'s slot in
  `tasks-client.tsx`; the CopyCommand/PassBar reuse is already production
  components. Rewrite under real constraints (tests, a11y pass) — prototype
  code was written throwaway.
- **Honesty rules**: never show a step the backend can't detect (e.g. no
  "install the SDK" check); the traces pre-step appears only when true.
