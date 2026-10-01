# Mode-by-mode results + the 21-run scoreboard (writer's reference, 2026-09-21)

> **EXTENDED 2026-09-29 — 57 gold runs.** A second project (bind) held 36
> more DABstep runs under an older eval generation (gold check named
> `<task>-upstream-answer` — same deterministic benchmark comparison).
> After judging those too, the fair-pair totals became:
>
> | | agreement | false-PASS | false-FAIL | refusals | cost p50 | latency p50 |
> |---|---|---|---|---|---|---|
> | single-shot | **62.5%** (35/56) | **20** | 1 | 1 unparseable | $0.0015 | 26 s |
> | agent-judge | **100%** (53/53) | **0** | 0 | 4 "could not verify" | $0.0017 | **24 s** |
>
> Gold mix now 27 right / 30 wrong. All 4 refusals were on **wrong**
> answers — the agent-judge never once vouched for a wrong answer in 57
> runs. History tools used 57/57. At the median the agent-judge is now
> *faster* than the single-shot call (24 s vs 26 s) and costs the same.
> New mode-2 flavor from the extension: passing 0.117667 (correct
> 0.120132) with *"corresponds to an average fee of 10 × 0.0117667 EUR …
> a coherent …"* — the judge did arithmetic to rationalize a wrong number.
> The 21-run tables below stay as the original write-up's receipts; cite
> the 57-run totals for the headline claims.

Everything needed to write "the agent-judge vs the LLM judge" proof
sections. Corpus: 21 finished DABstep attempts recorded in apo (some
questions attempted 2–3×), each already graded by the deterministic
`answer-matches-benchmark` check — 8 right, 13 wrong, no LLM in the
grading. The campaign judged each attempt twice (same model
`deepseek-v4.1-flash` both arms, same rubric, answer key hidden):
single-shot sees question + answer; agent-judge gets the tool log + prior
runs. Then both were scored against the key on record.

## The scoreboard (all 21, in plain words)

### The 13 wrong answers — where judges earn their keep

| # | Question (plain) | Agent answered | Correct answer | Single-shot judge said | Agent-judge said |
|---|---|---|---|---|---|
| 70 | Is this merchant in danger of a high-fraud fine? | yes | **Not Applicable** (rule doesn't cover it) | **PASS** — "the merchant's fraud rate exceeds the relevant threshold" *(invented — no threshold in input)* | **FAIL** — found "Not Applicable" in the prior run's report; the agent never checked whether the rule applies |
| 70 | same question, 2nd attempt | yes | Not Applicable | FAIL (right, this time) | FAIL — same diagnosis as above |
| 49 | Top country for fraud? (NL/BE/ES/FR) | A. NL | **B. BE** | **PASS** — "matches the expected top country… in the DABstep #49 task" *(asserted an answer key it never saw)* | **FAIL** — prior run's report says B. BE; work also too shallow (3 calls, unfiltered count) |
| 49 | same question, 2nd attempt | A. NL | B. BE | **PASS** — same key-assertion | **FAIL** — same |
| 1464 | Which fee IDs apply to account_type R, aci B? | 34, 39, 49, 62… | **1, 2, 5, 6, 8, 9…** | **PASS** — "a list of fee IDs, which directly matches the requested output" *(any list matches that logic)* | **FAIL** — tool log shows two candidate sets (strict vs permissive); the run submitted the wrong one |
| 1871 | Fee delta for Belles if fee #384's rate → 1 | 728.288966 | **−0.948103** | **PASS** — "consistent with the expected scale and precision" *(700× off, wrong sign)* | **no verdict** — couldn't verify in budget; recorded "could not verify" instead of passing |
| 1305* | Avg GlobalCard fee, type H, restaurants, 10 EUR | 0.071 | 0.123217 | FAIL | FAIL |
| 2697 | Cheapest ACI to move fraud to (Belles, Jan) | All:39.17 / GlobalCard:0.16 | E:13.57 | FAIL, FAIL | FAIL, FAIL |
| 1681/1753/others | Belles fee IDs (Jan 10 / March) + one empty answer | — | specific ID lists | FAIL | FAIL |

\* remaining wrong-answer rows: both judges agreed FAIL — no dispute.

### The 8 correct answers — where the mirror error shows

| # | Question (plain) | Agent answered | Correct | Single-shot said | Agent-judge said |
|---|---|---|---|---|---|
| 1305 | Avg GlobalCard fee, type H, restaurants, 10 EUR | 0.123217 | 0.123217 ✓ | **FAIL** — "no supporting tool_log … or intermediate work shown" *(it was never given the work)* | **PASS** — reconstructed the fee-filter computation from the tool log; prior runs confirm 0.123217 |
| 1305 | same, 2nd attempt | 0.123217 | ✓ | PASS | PASS |
| 1273 | Avg GlobalCard fee, credit transactions, 10 EUR | 0.120132 | ✓ | PASS | PASS |
| 1273 | same, 2nd attempt | 0.120132 | ✓ | no verdict (unparseable) | PASS |
| 1464 | Fee IDs for account R, aci B (the right list) | 1, 2, 5, 6… | ✓ | PASS | PASS |
| 1681 | Belles fee IDs, Jan 10 | 286, 381… | ✓ | PASS | PASS |
| 5 | Issuing country with most transactions (×2) | NL | NL ✓ | PASS, PASS | PASS, PASS |

Three things to point at while writing:

- **The wrong-answer block, single-shot column: five bold PASSes. The agent-judge column: zero.**
- **The live coin flip:** question #70 — same answer "yes" on two attempts, the single-shot judge said FAIL then PASS, same model. Mode 5 in one row.
- **The mirror pair:** question #1305 — the single-shot both *failed a correct answer* (1st row) and, on its sibling attempt, passed it: both error directions on the same question. The agent-judge passed both, citing the reconstructed computation.

## Aggregates (for right after the chart)

- single-shot: **70.0%** agreement, **5 false-PASS**, 1 false-FAIL,
  1 no-verdict · $0.0009 median · 28 s p50
- agent-judge: **100%** of its 20 verdicts correct (0 false-PASS,
  0 false-FAIL), 1 budget-exhaustion fail-closed · $0.0018 median ·
  44 s p50 · median 5 steps · used history tools in 21/21
- ablation single+worklog staged: 73.7%, still 5 false-PASS
- ablation agent without history: 66.7% of decided, 9/21 timed out
- model floor: gemini-2.5-flash-lite completed 0/3 agent sessions

## Mode → row → quote (how to prove each point)

Pattern for every mode: **claim → point at the row → quote both judges'
reasoning on that row → one-line lesson.** The reader checks the row in
the table, reads the two verbatim reasons, and the point proves itself.

**Mode 1 (fabricated verification) — rows `merchant…yes` and `top-ip…A. NL`.**
Single: "the merchant's fraud rate exceeds the relevant threshold, so
'yes' is the expected answer" (no threshold existed) / "matches the
expected top country for fraud in the DABstep #49 task" (never saw the
key). Agent on the same rows: FAIL — it pulled the prior attempt's check
report (`get_run`) and found the real expectations ("Not Applicable",
"B. BE"). Lesson: it replaced invention with lookup.

**Mode 2 (plausibility as correctness) — row `fee-delta…728.288966`.**
Single: PASS because "consistent with the expected scale and precision."
Agent on the same row: no verdict — it read the task + deliverables
(4 steps), could not verify the number inside its budget, and **recorded
"could not verify" instead of passing**. In apo that lands as a failing
check with the explanation attached: a loud failure a human looks at, not
a silent pass that ships a bug. Then the mechanism, one sentence: staging
the work log into the single-shot prompt still left all five false passes
(73.7%) — plausibility survives more data; procedure kills it.

**Mode 3 (style passes for substance) — the t-agent-demo run** (not in the
21; it's the demo). Same deliverable, two rubrics: form-rubric PASS
(2.6 s) vs investigation-rubric FAIL with per-figure forensics
(3 steps, 17 s). Lesson: the mode was never a judge bug — the rubric
degraded because the judge couldn't verify; give it verification and the
real rubric becomes writable.

**Mode 4 (failing correct answers) — row `avg-fee…0.123217`.**
Single: FAIL, "no supporting tool_log … shown" (it was never shown the
work). Agent on the same row: PASS — reconstructed the fee-filter
computation from the tool log AND cross-checked the benchmark value in
prior runs before vouching. Lesson: verification cuts both ways — catches
lies and backs truths.

**Mode 5 (coin flips) — the two `merchant…yes` rows.**
Same question, same answer, same single-shot model: once FAIL, once PASS.
Nothing in the campaign fixes this (one sample per arm; we've watched
agentic sessions flip at temperature 0 too). What works: adjudicate edge
cases in the rubric, sample (`rejudge --samples N`), pick a model that
holds the loop. Consolation: an agent-judge that can't decide fails
loudly, it doesn't flip silently.

## Where the raw quotes live

- `campaign-sessions/<run>_single_deepseek…json` / `_agent_…json` — both
  reasonings verbatim per row
- `CASE-STUDY.md` — the three worked cases with check tables and session
  step timelines
- `CAMPAIGN.md` / `campaign-report.json` — aggregates
