# Landing-page prototype — the application as the first page

> **PROTOTYPE — throwaway.** Do not link from anywhere; delete or absorb
> once the question below is answered. (See `.agents/skills/prototype`.)

## The question

respan.ai's panels feel like "the real application" because they're
pixel-faithful recreations plus a live-demo link. Should apo's first page
show the **complete application window** — ported shell and pages, with a
scripted live loop inside — instead of marketing fragments? (Verified:
respan's panels are static HTML fragments, not videos or full windows;
their "View logs demo" link does the real-work feeling.)

## Where it lives

- Route: `/prototype/landing?panel=specify|run|verify|engineer`
  (`←`/`→` cycle pages when nothing interactive is focused).
- Code: `apps/docs/src/components/prototype/` —
  - `capability-sim.ts` — the scripted fixture (task, spans, tests,
    judges, harness versions) + verdict math. Pure data.
  - `use-capability-sim.ts` — the driver hook. The sim clock is absolute
    (performance.now() − run start) and ticks come from a Web Worker:
    an occluded webview starves page timers while its event loop stays
    alive, and worker timers keep firing, so the demo streams instead of
    freezing.
  - `native.css` + `native.tsx` — **pixel-faithful ports of the real
    dashboard** (app shell: top nav, inset sidebar, breadcrumb bar,
    status bar; pages: run-detail head, OutcomeSummary, checks list,
    TaskRunTabStrip, task-detail head; lucide icons with verbatim path
    data), with their original Tailwind class names re-implemented under
    a `.pl-native` scope and the dashboard's exact OKLCH tokens.
    Verified against the live dashboard (docker :3000 demo project) by
    computed-style audit.
  - `variants/AppShell.tsx` — the one presentation: hero + numbered tour
    strip + the full application window. The tour pages map to real
    surfaces: Specify→Tasks, Run→Traces (live stream + waterfall),
    Verify→Runs (run detail), Engineer→Runs (loop/compare). Schedules is
    dimmed, honestly marked "not in this prototype".
  - `panels/` — the four live pages. Verify is a literal run-detail page
    (Checks / Conversation History / Deliverables tabs); Specify is the
    task-detail head + checks-list pattern with per-test toggles.
  - `CapabilityShowcase.tsx` — root island; ?panel= deep links,
    client-adopted (Astro 7 strips query strings from static routes).

Run: `pnpm docs` (or `cd apps/docs && node_modules/.bin/astro dev` if the
workspace manifest is mid-conflict). No backend, no model calls — one
deterministic in-browser simulation of the whole loop.

The "real application" feeling = fidelity (solved by porting) + full-shell
framing (solved by the shell) + a live escape hatch: the hero's
"Open the demo project →" CTA points at the local demo stack
(:3000/project/demo); the real landing would point at the hosted demo.

## The demo's one story (all three variants share it)

Task `process-refund-request` (a support agent that must read a damaged-
order email, refund within policy, and write the reply):

- **v1 fails 3/5** — the reply is a form letter; both judged tests fail
  (one with a `✓✗ 0.99` second-judge split).
- Fix 1 (wiring: pass the email body) → **v2 fails 4/5**.
- Fix 2 (prompt: tone guide) → **v3 passes 5/5** — loop closes.

Four surfaces (was five — trace folded into Run, matching how the product
reaches the trace from the run): **Specify** (suite + test toggles),
**Run** (live span stream while running, trace waterfall once settled,
span detail, deliverables), **Verify** (run-detail: checks, conversation,
deliverables tabs), **Engineer** (fix catalog + convergence).

Everything is interactive: run/re-run at 1×/2×, click spans mid-stream,
expand judge evidence, toggle tests off in the spec (the verdict recomputes
and calls you out for going green by subtraction), apply fixes, compare
graded signals across versions, reset.

## Verdict — PENDING (fill in before deleting)

Which variant won, and which bits to steal:

- A — Tabbed showcase: \_\_\_
- B — Loop stepper: \_\_\_
- C — App chrome: \_\_\_

Decisions worth keeping regardless of variant: \_\_\_
