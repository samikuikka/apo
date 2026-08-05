# Tasks Overview Prototype

## Question

How should the main Tasks page show one trustworthy current state while still
making history, model experiments, execution revisions, and Task Definition
changes discoverable across the whole Project?

## Variants

v1 (single Project-wide hardcoded scope):

- `modes`: Overview, Trends, and Breakdown are explicit page modes.
- `rows`: every Task row shows baseline, history, and model evidence together.
- `lens`: a persistent analysis sidebar changes the table's comparison axis.

v2 (run-level evidence, real backend dimensions):

- `cohort`: published Task Definition + source commit cohort with a model
  picker. Empty rows surface Tasks with no comparable runs.
- `schedule`: each Task's primary schedule defines current evidence. Manual
  and CI runs are Trends-only. Tasks without a schedule fall back to a
  clearly-labelled provisional number.
- `filters`: the normal Tasks page with a horizontal bar of filter chips
  (model, definition, source, trigger). Rejected — visually too heavy and
  detached from the table.
- `columns`: **leading direction.** Data table styled like the traces page
  with column-header autoFilter dropdowns. Each dimension (Model,
  Definition, Source, Trigger) is a column with a multi-select dropdown in
  its header; metric cells recompute per row. Default = all values
  selected.

Cycle with `←` / `→`.

## What the data model actually stores (v2 fixtures are grounded in this)

Confirmed against `backend/apo/models/schemas.py` and `execution.py`:

- **No stored baseline exists anywhere.** Not per-Project, not per-Task. The
  fixture's old `BASELINE_SCOPE` was invented.
- Each Task Run carries `run_configuration: {model, effort}` per run, plus
  `task_source_commit_sha`, plus its parent Batch's `task_revision`
  (`commit_sha`, `content_sha256`, `dirty`).
- Each Run's `trigger` distinguishes `schedule_id` / `schedule_name`,
  CI (`commit_sha`, `pr_number`), manual, and ad-hoc.
- `AgentTaskBatchRunConfigurationSummary` already classifies batches as
  `uniform / mixed / partial / unknown` — apo knows when a cohort is mixed.
- `AdaptiveTaskStateSummary` (`consecutive_passes`, `last_status`,
  `next_run_at`) is the only per-Task derived state today; the production
  Tasks page doesn't surface it.

So "current trustworthy state" is a **derivation choice**, not a stored fact.

## Verdict

### State model

**`columns` is the right top-level frame. `schedule` and `cohort` become
presets, not separate modes.**

`columns` solves the same problem as `filters` but lives inside the table
chrome, matching the traces-page aesthetic. Each dimension apo records
becomes a column header with an autoFilter dropdown:

- Header shows label + active-filter count badge + filter icon
- Dropdown shows distinct values with checkbox + count, plus
  `Select all` / `Clear` actions
- Default = all values selected (the honest total)
- The dimension columns ALSO show per-row values: `Opus 4 · high` for
  uniform tasks, `2 values mixed` when a task spans multiple

This subsumes the other two the same way `filters` did, but without
feeling like a separate UI layer:

- Uncheck every Trigger except `schedule` ⇒ schedule-anchored view
- Uncheck every Definition except `b772ef1` and every Source except
  `b772ef1` ⇒ published-cohort view
- Both together ⇒ schedule-anchored on current published state

Verified in the browser: unchecking just `manual` drops `security-audit`
to "No baseline" (all its runs were manual) and reduces `billing-dispute`
to 100% over 3 Sonnet scheduled runs.

Doing it this way has four big wins:

1. **No magic baseline.** apo doesn't actually store one (confirmed against
   `schemas.py`). `cohort` and `schedule` both invented a derivation and
   then hid it behind a single number. `columns` makes the derivation
   visible and user-controllable — the "trustworthy" question becomes
   "what filter is applied," answerable in one glance at the headers.
2. **Mixed-model Projects are first-class.** The dimension cell itself
   shows `2 values mixed` when a task spans multiple models — the
   per-row signal that `cohort` and `schedule` lacked.
3. **Visually continuous with the rest of apo.** Same `Table` primitives,
   same uppercase tracked headers, same sticky chrome as the traces page.
   Users who know one data table know them all.
4. **Empty rows are honest.** When filters exclude every run for a Task,
   the page says "No runs match" instead of falling back to a stale
   all-history number.

The catch (unchanged from `filters`): **the unfiltered default is the
broken all-history view we are trying to fix.** So `columns` still needs
smart defaults applied on first paint — see below.

### Smart defaults

The right default is not "all runs" and not "one invented baseline." It is
**the most-recent comparable cohort**, computed once on page load and
applied as the initial filter state (with all checkboxes pre-checked or
unchecked accordingly):

- Definition = latest published Task Definition revision.
- Source = current `ProjectTaskSource.last_resolved_commit_sha`.
- Model = the most common `run_configuration` among runs matching the
  above (or leave all selected if the Project is genuinely mixed).
- Trigger = unset (all selected), so manual experiments stay visible.

The user sees a trustworthy current view on first paint and can broaden,
narrow, or pivot from there. The column-header dropdowns show *why* this
is the current view, which is the cheapest trust fix in the prototype.

### Mixed-config schedule detection

`account-cancellation` declares an Opus schedule but ran Sonnet twice.
Under `columns` this surfaces in two places:

- The Model cell shows `2 values mixed` for that row.
- Setting Trigger to `schedule` only and seeing a 60% rate over 5 runs;
  narrowing the Model column to `Opus 4 · high` reveals the 100% rate
  over 3 runs.

The chip in the `schedule` variant remains a useful permanent signal —
worth folding in as a small `mixed` pill next to the dimension value,
reusing the existing `WarningChip` component.

### UI improvements (fold into whichever direction ships)

1. **Kill the all-history column.** Don't show it struck-through as
   "legacy" — it's the misleading number we're replacing, not a fallback.
2. **Evidence line under every baseline number.** `Opus 4 high · b772ef1 ·
   6 in cohort` is the cheapest trust fix in the prototype.
3. **Sample size as confidence.** `1 run · low conf.` is more honest than
   a confident-looking percentage on a single data point.
4. **Per-row "what counted" strip.** Dim the runs that exist but were
   excluded. Users see at a glance *why* a number is what it is.
5. **Explicit empty states.** "Never run" / "No runs match filters" /
   "Schedule configured but never fired" are three different messages;
   render all three distinctly instead of an em-dash.
6. **Live filter totals + reset.** The `X of Y runs shown` footer and
   `Reset all filters` button in `columns` make active filter state
   visible without a separate drawer.

## Proposed next step

Spec a single Tasks page built around the `columns` frame:

1. **Use Tanstack React Table** (same as traces) so we inherit sorting,
   column visibility, pinning, and resize for free.
2. **Dimension columns with `ColumnFilterHeader`.** Model, Definition,
   Source, Trigger. Each is a multi-select dropdown with `Select all` /
   `Clear` and per-value counts. Smart defaults applied on first paint.
3. **Metric columns.** Pass rate (with `EvidenceLine`), Sample (with
   low-confidence warning), Errors, Cost, History strip.
4. **No separate "modes" or "lenses."** Trends becomes a per-Task drill-
   down (already prototyped in `task-performance-prototype`). Breakdown
   is just `columns` with two dimensions narrowed and the user looking
   at the delta — no dedicated affordance needed.

Promote `data-v2.ts` and the `ColumnFilterHeader` / `EvidenceLine` /
`RunStrip` / `PlainHeader` components to the spec. Do not ship the
prototype directly.

### What `cohort`, `schedule`, and `filters` still teach us

Keep all three in the prototype rotation as comparison material:

- `schedule` shows what a strong default looks like — "scheduled =
  canonical" is a defensible product opinion, and the drift chip is a
  real signal worth porting into `columns` as a per-row `mixed` pill.
- `cohort` shows the cleanest published-scope framing — useful if the
  "current published definitions" concept becomes a first-class Project
  attribute later.
- `filters` is the same idea as `columns` with a worse chrome — kept so
  the team can see why column-embedded filters win.

But the spec should not implement them as separate pages. They are
presets or inspiration, not modes.

## This is disposable

This fixture-backed code is not production. A chosen direction must become
a new implementation spec, not a copy of these files into the real page.
