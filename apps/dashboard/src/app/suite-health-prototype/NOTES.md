# Suite health · UI prototype (round 2)

**Question**: belief 9 says "surface tests that never fail and make pruning a
deliberate, normal act", but nothing in production surfaces them. Round 1
(2026-11-20) put every classifier state on one page; the first reader rejected
it ("too many things to notice, a mess of different stuff"). Round 2 starts
from how the field actually does this.

**Route**: `/suite-health-prototype?health=0|A|B&project=<id>`, arrow keys
flip; the floating bar also carries a Data toggle. (`?health=`, not
`?variant=`/`?monitor=`/`?trend=`; the shell, monitors, and trends prototypes
own those params.) `?data=demo` swaps the real fetches for a deterministic
fixture. Top-level on purpose: the project layout's auth guard sends every
`/project/...` page to /login, and the prototype opens in any browser with
zero login. Demo mode computes everything locally; real-data mode without a
session renders the empty state.

## What the field does (research 2026-11-24)

Products surveyed: GitHub Actions (+ internal flaky tooling), CircleCI Test
Insights, Buildkite Test Engine, Datadog CI Test Visibility, Gradle
Develocity, TeamCity mute, Cypress Cloud, Launchable. Org practices: Google
(Testing Blog, SE at Google), Meta (PFS), Uber (Testopedia FSM), Slack
(Cornflake), Microsoft (CloudBuild, lifecycle study). Recurring patterns:

1. **Inline label at the point of results** (FLAKY badge on the row), not a
   distant report.
2. **One ranked table, hard cap, fixed short window** (top-100, 14/30 days);
   rank by impact or score, never raw counts.
3. **Advisory beats stateful for never-failing tests**: 6 of 8 products show
   nothing for them at all. Launchable is the only explicit list ("Never
   Failing Tests", eligibility: 5+ runs/week, framing "cats who never catch
   mice", advice: judge run cost, run it less, or remove; no buttons).
4. **A middle tier that keeps running but stops blocking** (Buildkite muted,
   Datadog quarantined, TeamCity mute with until-date resolution). Never
   auto-deletion anywhere; Google frames deletion of obscure tests as a
   failure mode.
5. **One metric per row** ("last flaked", flakiness score, reliability %);
   per-test history lives on the detail/expand, never in the main list.
6. **Run it less, not delete it**: Develocity PTS and Launchable deselect;
   for apo the native equivalent is the adaptive scheduler's back-off.

Design rules drawn for round 2: one metric ("Last Failed"), one table per
question, ranked, eligibility threshold (under 5 graded runs in window is a
footnote, not a state), always-failing is a separate short list (different
action: inspect, never prune), detail on row expand only, one action per row
(Run less) plus a snooze (Keep), zero classifier vocabulary in the UI.

## Variants (round 2)

- **A · Never-Failing List**: the focused page. Summary line, then one table
  ranked by runs (Test / Last Failed / Runs / Cost per Mo / Run less / Keep),
  row expand shows per-model counts and what Run less does. "Always Failing"
  is a second, smaller list with no actions. The retired/Keep flows from
  round 1 survive only as stubs here.
- **B · Tasks Column**: the ambient pole. One chip ("4 tests never failed in
  the last 40 days · review") plus ONE column on the Tasks list: Last Failed
  ("never" in warning, "failing since Nov 3" in destructive, plain dates
  muted, "n/a" under 5 runs). The entire health surface is one column.

Round 1 variants (Review Page with 7 classifier states grouped into 5 tables,
Tasks Column with state labels, Retire-Not-Delete lifecycle page) were
rejected 2026-11-24 and deleted; the retire-not-delete semantics survive as
the Run less stub and the expand explanation.

## Classifier (health-data.ts, internal only)

Per task, newest 60 runs: graded = passed + failed (errors are never
verdicts). The UI consumes only: `lastFailedAt` (null = never), `graded`,
`failStreak >= 8` (always-failing), `graded < MIN_GRADED(5)` (footnote),
`costPerMonth`, facets for the expand line. The 7-state enum stays internal
for potential future use; no state name reaches the screen.

## Demo dataset (?data=demo)

60 suite-scale runs over 40 days ending 2026-11-18, three model phases
(deepseek 1-24, glm 25-38, gemini-flash-lite 39-60), the 18 real task paths,
deterministic patterns. Round-2 roles: 4 never failing (`data-extraction-replay`,
`t-agent-demo`, `t-describe-groups`, `t-jekyll-split` gemini-only), 1 always
failing (`web-research-summaries`, fails since run 30), 1 erroring
(`t-summarize-thread`, shown only in the "failed at least once" count; errors
are not a health verdict), 1 too new (`steering-correction`), the rest carry
signal. Real-data honesty notes: `started_at` nullable (batch date fallback),
model from `run_configuration.model` with fallbacks, cost/mo from priced runs
in the last 30 days scaled for unpriced ones.

## Research references

- Launchable Unhealthy Tests (the never-failing precedent):
  https://help.launchableinc.com/features/unhealthy-tests
- Buildkite test state and quarantine (muted tier):
  https://buildkite.com/docs/pipelines/configure/tests/test-suites/test-state-and-quarantine
- Datadog flaky management (lifecycle, caps, windows):
  https://docs.datadoghq.com/tests/flaky_management/
- TeamCity mute (resolution policies, doctrine):
  https://www.jetbrains.com/help/teamcity/investigating-and-muting-build-failures.html
- CircleCI Test Insights (ranked capped tables):
  https://circleci.com/docs/guides/insights/insights-tests/
- Develocity flaky detection + predictive selection:
  https://docs.develocity.ai/2026.2/using/develocity/flaky-test-detection
- Google, Flaky Tests at Google (quarantine risks, "reliable failure beats
  flakiness"): https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html
- Meta, Probabilistic flakiness (score + confidence, per-test history):
  https://engineering.fb.com/2020/12/10/developer-tools/probabilistic-flakiness/
- Uber, Flaky Tests Overhaul (per-test FSM, audit trail, no auto-delete):
  https://www.uber.com/blog/flaky-tests-overhaul/
- Slack, Handling Flaky Tests at Scale (suppress execution, not results):
  https://slack.engineering/handling-flaky-tests-at-scale-auto-detection-suppression/

## Verdict

_(pending · round 2 flipped with ←/→; A is the dedicated page, B is the
embedded column; likely B's column ships for awareness and A's list carries
the decision. Then this directory is deleted and the winner is folded into a
real surface.)_

> Throwaway prototype directory. Remove once the question is answered.
