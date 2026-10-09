# Tasks page "views" chrome — UI prototype

**Question:** How should evidence views (saved run-cohort scopes) be presented
on the Tasks page? Today the page stacks an editor-style closable tab strip
(permanent "Main" + derived copies) on top of an always-visible dense filter
row (search + status + model/effort/date/host). The owner is not a fan of the
views or how they read now. This prototype explores structurally different
answers; the list below the chrome stays identical so variants are compared
on the views experience only.

**Plan line:** Four variants of the Tasks views chrome, switchable via
`?vproto=`, mounted on the real `/project/<id>/tasks` route (read-only —
no saved-view writes leave the page). Bottom bar flips variants (←/→).

## Variants

- `cur` — **Baseline (today's UI).** The production `EvidenceViewsBar`,
  rendered with prototype-local state so it can be compared side by side.
- `a` — **Filter bar + views menu** (Datadog/Linear pattern). No tabs. One
  row: search, status menu, cohort chips (model/effort/since/host, each
  removable), "Filter +" popover, and a Views dropdown that lists saved
  views, applies them, and saves the current chip state as a new view.
  Unsaved edits show a modified dot on the active view (GitHub-style).
- `b` — **Minimal tabs** (GitHub Projects pattern, decluttered). Tabs stay
  the metaphor but collapse to one row: name-only pills, close on hover,
  "+" duplicates, per-view config behind a gear popover, search + status on
  the same row. Tests "right concept, too much chrome today?"
- `c` — **Cohort overview band** (apo-specific; no competitor does this).
  Views are really *comparisons* — so the models themselves render as a
  band of stat cards (runs, weighted pass rate, effort split); clicking a
  card scopes the list, "All history" is the first card, saved views sit in
  a small "Shortcuts" dropdown. Answers "should the cohorts be visible
  side by side instead of chosen one at a time?"

## Research grounding (2026-10-24, sourced from official docs)

- Top tabs (GitHub Projects, Notion) work only for few, shared views;
  GitHub's own ecosystem shows the ceiling (25-view cap complaints, tab
  crowding). apo's current strip is this pattern plus heavy per-tab chrome.
- Compact dropdown + implicit personal default (Datadog Log Explorer /
  Monitors) preserves vertical space for rows and scales past ~10 views —
  the research's pick for data-dense dev tools.
- Ephemeral filters with a contextual "save as view" (Linear `Alt+V`,
  GitHub's unsaved-changes dot) is worth stealing in every variant.
- Starring/favorites to pin high-traffic views (Datadog, Jira, Airtable,
  Linear all converge on it).

## Verification (2026-10-24, dev server :3100 → backend :8000, project `bind` e06c87103f95: 6 models, 20 tasks, 1 real saved view)

All four variants screenshotted and driven in headless Chromium with a real
session. Verified by screenshot review plus DOM assertions:

- `cur` renders the production bar pixel-faithfully (it *is* the production
  component), seeded with the project's real saved view "View 1"
  (google/gemini-2.5-flash-lite). 20 tasks, pass bars, folder groups intact.
- `a` single row renders (no tab strip). Status menu, "+ Filter" menu with
  model rows + mono counts, chips appear on selection
  (`model: deepseek/deepseek-v4.1-flash`), "scoped" indicator appears, list
  re-renders with the cohort's stats overlay. Views menu lists Main +
  "View 1" with summaries, star toggles, and the save-as-view input.
- `b` one row, name-only tabs ("Main", "View 1"), dashed "+", Config gear,
  Status, search, expand/collapse all on the same row.
- `c` cohort band renders "All history" (22 runs, 71%) plus one card per
  model with real run counts and weighted pass rates. Clicking
  deepseek/deepseek-v4.1-flash highlights exactly that card (DOM-asserted),
  scoping indicator appears, and the 20-row list re-renders with the
  overlay (rows without runs in the cohort read "Ready to run" — same
  semantics as a derived tab today).
- Switcher: bottom pill flips variants, ←/→ keys cycle (ArrowRight moved
  a→b, URL param updated), label updates, and the bar is gated out of
  production builds.

Known prototype limits: selection actions (Run/Compare bar) are out of
scope — checkboxes toggle but no action bar appears; saving a view is local
memory only (nothing persists, by design); archived models are hidden from
variant c's band.

## How to try it

`pnpm --filter dashboard exec next dev -p 3100` with
`NEXTAUTH_URL=http://localhost:3100` (already running as of writing), then
log in as `admin@test.com` and open
`http://localhost:3100/project/e06c87103f95/tasks?vproto=a` (or `cur` /
`b` / `c`). Flip with the bottom bar or arrow keys.

## Round 1 verdict (2026-10-24): no winner

Owner: "not huge fan, maybe the A or what we have now, not sure, all
doesn't feel right" — lean A or baseline, nothing landed. Follow-up
answers: "everything with the views feels a bit out of place", and the
daily job on this page is **comparing models**. Diagnosis: every round-1
variant (and today's UI) kept the same premise — cohort *scoping* as a
first-class layer — while the owner's question is a *comparison*.

## Round 2 — variant `d`: the comparison IS the page

Scoping answers "what did this one cohort do"; the owner's daily question
is "which model passes what" — which no round-1 shape shows without
clicking through cohorts one at a time.

`?vproto=d` attacks the premise: **no view chrome at all.** Rows are tasks
(folder-grouped), columns are models plus "All", each cell is that task's
pass rate under that model (colored % + bar; "—" when never run under that
model). Clicking a cell opens the task's run history scoped to that model
(`?model=…`, the same deep link a derived view produces today). Search is
the only control left.

Verified 2026-10-24 on project `bind`: 7 columns, 20 task rows + folder
sections, 120 model-scoped links with correct hrefs, aggregates in column
headers (runs · pass %), sticky task-name column and header row.

Data note discovered while verifying: most historical runs in `bind`
belong to tasks that are no longer in the catalog (z-ai facet claims 28
runs; the overlay over catalog tasks returns 0). The matrix — like the
production task list — only shows catalog tasks. If that blind spot
matters, a future "off-catalog runs" row is a backend question, not a
prototype one.
