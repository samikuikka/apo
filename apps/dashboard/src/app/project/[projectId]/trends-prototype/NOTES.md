# Run trends · UI prototype

**Question**: Where should apo's run-evolution view live, and which signal
carries it? A dedicated trend page with a line chart (A), a task-by-run
matrix page (B), or compact sparkline strips embedded in the existing Runs
page (C)? And when averages hide single key breaks, which interaction
carries per-case flips: an ambient since-last-run list (D) or an explicit
pick-two run diff (E)?

**Route**: `/project/<id>/trends-prototype?trend=0|A|B|C|D|E`, where 0 is the
Original (empty page, today's state); arrow keys flip variants; a floating
bar at the bottom cycles them. (`?trend=`, not `?variant=` or `?monitor=`;
the shell's status-bar and monitors prototypes own those params; on this
page our key handler claims the arrow keys so only one switcher flips.)
Variant E adds `?base=`/`?cand=` batch run ids, defaulting to the latest
run vs the one 10 positions earlier.
Live for the main project at
`http://localhost:3002/project/e06c87103f95/trends-prototype?trend=A`
(swap `A` for `B`, `C`, `D`, `E`, `0`). All numbers are computed from the
project's **real** batch runs (last 60) and task runs; nothing below is
fixture data except variant C's placeholder table rows.

**What this is** (not the monitors/automations windowed-threshold concept):
the human trajectory view. Pass-rate drift over the last runs, attribution
of visible steps to model changes, and drill-down to the actual runs. The
monitors prototype answers "should I be alerted"; this answers "is the
harness under test getting better or worse as I change it, and what changed
around the jump".

## Variants

- **A · Checks Timeline**: one dedicated page, one main line chart. X is run
  index over the last 60 batch runs (oldest left), Y is the graded pass rate
  `passed_checks/total_checks` pinned to a fixed 0..1 domain. Errored runs
  (no completed evaluation) are a gap plus a small destructive tick, never a
  fake zero. Thin gray vertical markers where the distinct model set
  changes, with the new model name in tiny text at the top. Hover shows
  date, checks x/y, model, and an "Open run" link. Cost and token sparkline
  rows sit below.
- **B · Task x Run Matrix**: the flakiness-grid pattern. A slim summary
  strip of per-run graded pass-rate bars on top, then a grid of rows (tasks,
  most recently run first, cap 25) x columns (the last 40 batch runs, oldest
  left). Each 12px cell: success fill = passed, destructive fill = failed,
  muted with a destructive border = error, quiet gray = did not run in that
  batch. Row headers carry the task path and a mono pass count like 48/52;
  cells link to the task run and show date, task, status, model on hover.
  A cell whose status differs from that task's previous run wears a thin
  foreground ring (added 2026-11-20 after the "why not show everything"
  challenge: everything stays visible, the changes get marked in place).
- **C · Runs Page Strips**: the embed pole. No new page; a quiet strip of
  three compact panels would sit above the Runs table. Pass Rate (last 60
  runs, 0..1 fixed sparkline), Cost (gaps for nulls, honest "no data"
  state), Tasks Passing (latest run per task: N/total mono text plus one 8px
  square per task). Previewed over five static placeholder rows so the
  density reads in context.
- **D · Since-Last-Run Flips**: the ambient flip pole. Automatic, per task:
  its two most recent runs in the window compared, nothing to pick. Rows
  show task path, prev graded signal to next in mono tabular text
  ("14/15 -> 9/15"), date and model per side, both sides linked to the task
  run. Regressions first, then newly errored, then fixes, then stable
  fails; tasks still passing collapse to one "N tasks still passing" line.
  An errored side renders as its own error state, never as failed; a run
  whose prev side errored has no verdict to compare, so it never counts as
  a regression or a fix.
- **E · Run Diff**: the explicit flip pole. Pick a baseline and a candidate
  batch run (prev/next steppers per side; the selection persists in
  `?base=`/`?cand=`). Side headers show date, graded pass rate, models.
  Tasks present in both runs diff by kind (regression, fix, stable, with
  error sides as their own honest state); quiet "Only in baseline" and
  "Only in candidate" sections list one-sided tasks. With this project's
  1-task-per-batch data those sections dominate, which is part of what E
  exists to show.
- **F · Foundry Panels** (added after a "visually hard to read" verdict on
  A-E, informed by a reference moodboard: CircleCI Insights, Buildkite Test
  Engine, perf.rust-lang.org, wpt.fyi, TrueFoundry): hero number first,
  ONE main chart carrying one story, model attribution moved into a quiet
  era band under the chart (proportional gray blocks, labels only on eras
  wide enough, tooltips carry the rest) instead of labels on the canvas,
  then three metric panels (cost, tokens, errored tasks) each with its own
  big value, delta, and mini chart. Color only for exceptions: red when
  errors exist or the pass rate fell, quiet grays otherwise.
  Reworked after a second verdict ("how should I even read that"): the
  hero is now **tasks passing now N/M** (a count, not a rate; on
  1-task batches a single run's check rate is a meaningless hero), the
  supporting stat is the window-wide checks rate, and a computed
  plain-language sentence ("Improving, up 6 points across the window ·
  running on gemini since Nov 3 · 1 run errored without a verdict") plus a
  how-to-read line sit between the numbers and the chart.

## Reader feedback

- 2026-11-20: the first reader could not tell what D was saying. Fixed in
  place. Plain group names with hints ("Got Worse · was passing, now
  failing"), status words next to the counts ("pass 4/4", "fail 3/4"),
  models shown inline only when they changed between the two runs (hover
  keeps both), and a plain-language header sentence instead of jargon like
  "flips" and "net".
- 2026-11-20: challenged with "why do I want this instead of just showing
  everything". Answer split: B now rings changed cells in the full grid
  (show everything, mark the deltas), D stays as the at-scale pole where
  scanning a full grid stops working.

## Measured data facts (2026-11-18, project `e06c87103f95`)

- All 155 batch runs have **exactly 1 task each**, so a per-batch-run suite
  pass-rate line is binary noise. The meaningful per-run Y signal is the
  graded one: `passed_checks / total_checks` (0..1). This is
  PROJECT-BELIEFS.md belief 5: per-run verdicts are binary, but binary
  verdicts do not survive aggregation; two failures are not equal and the
  trajectory needs the graded signal.
- `task_source_commit_sha` is **never populated** in real data, so
  commit-keyed change markers would always be empty. The model is the real
  attribution signal: on the wire it arrives as `run_configuration.model`
  (adapter-reported, e.g. `recorded:deepseek/deepseek-v4.1-flash`) with
  `model_providers[0].model` as the observed fallback; 22 of 155 runs carry
  neither. Change markers key on the distinct model set per run.
- Nulls are real and must render as gaps, not zeros: cost is null on
  114/155 task runs and tokens on 103/155 (batch-level sums are denser; this
  project's batches report 0.0 rather than null when nothing was priced).
- 18 distinct tasks ran in the last 30 days (48 across all time), so the
  Tasks Passing strip renders over a live task count, not a fixed 18.
- Errored runs exist (5/155 task runs, plus batches with `total_checks` 0);
  they are the gap-plus-tick treatment, not a zero.

## Demo dataset (?data=demo)

The real project's history is single-task batch runs, which starves the
variants of the suite-scale picture they are being judged on. `?data=demo`
(the floating bar's Data toggle) swaps both fetches for a deterministic
fixture in `trends-fixture.ts`: 60 batch runs over 40 days ending
2026-11-18, each running the full 18-task suite (runs 44 and 46 are
single-task `t-jev-split` debug runs, like prod CLI usage). Deterministic:
one seeded LCG, no Math.random, identical numbers on every reload. Links to
individual demo runs/tasks are dead by design; only the aggregate picture is
the point.

Story arc:

1. Runs 1-12 (`deepseek/deepseek-v4.1-flash`): suite pass rate wobbles
   47-65% under active harness engineering.
2. Runs 13-24 (same model): a harness fix at 13 starts a climb to ~80-89%.
3. Runs 25-38 (`z-ai/glm-5.3-flash`): the model switch at 25 regresses the
   docx family (schema checks fail) down to ~56-67%, fixed by 30, back to
   ~83% at 38. Run 31 is a fully errored batch (executor timeout, zero
   checks) so A shows a gap + red tick and B an error column.
4. Runs 39-52 (`google/gemini-2.5-flash-lite`): switched for cost, pass
   holds ~83-94% while per-task cost drops to $0.01-0.02 (batch cost steps
   from ~$0.70 to ~$0.22). At 53 a harness change regresses two tasks to
   ~67%, fixed by 55-56.
5. Runs 57-60 converge to 94%.

Standing traits: `t-jev-split` is flaky (~53% pass throughout),
`data-extraction-replay` never fails (a belief-9 pruning candidate),
`t-fact-check` enters the suite at run 20 (no cells before), and
`t-summarize-thread` errors about 1 run in 5.

Measured prod parameters it honors (docker main stack DB, 2026-11-19):
real model strings in prod frequency order (`deepseek/deepseek-v4.1-flash`,
`z-ai/glm-5.3-flash`, `google/gemini-2.5-flash-lite` as the three switches),
per-task cost $0.01-0.06 model-dependent with ~12% of task runs unpriced
(prod ~10%), batch cost/tokens as sums (never null), tokens per task 8K-75K
ordered deepseek > glm > gemini-flash-lite, checks per task 1-8 weighted
toward 2-6 (71% of graded runs land 1-4, prod 74%), 1-3 runs/day plus one
5-run burst day, and the real 18 task paths.

Honesty notes: in prod today 353 of 357 batch runs are single-task; the demo
deliberately scales batches to full-suite runs because suite-scale cadence is
the usage this view targets, so do not read the demo as today's literal prod
shape. The demo's whole-window outcome mix is 72% passed / 25% failed / 3%
error vs prod's 57/40/4: the arc improves, so the window average sits above
the early-phase levels that match the measured mix. Variant B caps at the
last 40 columns (runs 21-60), so `t-fact-check`'s entry at run 20 sits just
left of its window; see it with E using
`?trend=E&base=demo_bch_19&cand=demo_bch_20` (it lists under "Only in
candidate").

## Research references

- Arize Phoenix, dataset Metrics tab (trends across recent experiments):
  https://docs.arize.com/phoenix/datasets-and-experiments
- CircleCI Test Insights, most-recent-100-runs bar chart:
  https://circleci.com/docs/test-insights/
- Gradle Develocity Trends, granularity advice:
  https://docs.gradle.com/develocity/trends/
- Chromium flakiness dashboard, the task-x-run grid:
  https://ci.chromium.org/ui/flakiness
- Allure, per-test history:
  https://allurereport.org/docs/history/
- WPT.fyi, interop lines over time:
  https://wpt.fyi/interop
- Jenkins non-zero-axis failure mode (why the Y domain is pinned to 0..1),
  cargo-nextest issue 1158:
  https://github.com/nextest-rs/nextest/issues/1158

## Placement thinking (2026-11-24)

Who/when: D serves "which task regressed" (daily), E serves "did my fix
help" (daily, overlaps the existing compare feature), F serves "are we
better than two weeks ago" (weekly/CI only). Prior art places trend views
attached to the repeating object (Phoenix: Metrics tab on the dataset;
CircleCI: Insights nav visited weekly; Braintrust: no trend chart, the
experiments table is the history). Standalone trend pages (rustc-perf,
wpt.fyi) are public status pages fed by machines. If this ships: flips
strip atop Runs, per-task history coloring on the task page's existing
run rail, and F as a tab beside Runs whose value arrives with scheduled
suite runs. Today's single-task ad-hoc usage starves the suite line; the
enabler is suite-scale cadence (schedules/CI), not more UI.

## Verdict

_(pending · flip with ←/→ and pick; the winner decides whether trends live
on their own page (A/B) or embed into Runs (C), then this directory is
deleted and the winner is folded into a real surface)_

> Throwaway prototype directory. Remove once the question is answered.
