# Draft section: the problems with single-shot judges, then DABstep (2026-09-21)

Blog-ready draft for the section that precedes the case studies
(`CASE-STUDY.md`). Voice is first-person; numbers and quotes are real, from
the campaign / repo docs / literature cited at the end.

---

## What actually goes wrong with an LLM judge

The single-shot judge — send the value plus a rubric to a model, get PASS or
FAIL — is the standard tool, and for a lot of checks it's the right one. It
is cheap, fast, and on my measurements it agrees with a calibrated second
opinion 96% of the time. The problems start in one specific place, and it's
worth naming it precisely, because every failure mode below is the same gap
in a different costume:

**The judge sees only what you stage.** When the rubric implicitly depends
on evidence that isn't in the prompt — the agent's actual work, the state of
the world, the right answer — the judge cannot verify. It can only assess
plausibility. And an LLM never abstains; it produces a confident
justification either way.

### Failure mode 1: fabricated verification

The judge invents a fact to rationalize a pass. Judging a run that answered
"yes" to "is this merchant in danger of a high-fraud-rate fine?", my
single-shot judge wrote:

> "The submitted final answer is 'yes', which directly answers the question.
> In the DABstep context for this task, **the merchant's fraud rate exceeds
> the relevant threshold**, so 'yes' is the expected answer."

There was no threshold in anything it saw — it fabricated a verification.
On a multiple-choice question it asserted that the answer "matches the
expected top country for fraud in the DABstep #49 task": knowledge of an
answer key it has never held. This is the most dangerous mode, because the
reasoning *reads* authoritative, the check says PASS, and the wrong answer
ships.

### Failure mode 2: plausibility as correctness

A softer cousin: no invented fact, just "looks right" standing in for "is
right". Passing a wrong dollar figure because it was:

> "consistent with the expected scale and precision for this computation."

Right order of magnitude, right format, wrong number. Plausibility is what
a judge falls back on when verification isn't available — and most wrong
answers to hard questions are precisely *plausible*.

### Failure mode 3: the vacuous pass

Sometimes the rubric is the bug. If all you can ask is "is this a coherent,
well-formed report?" — because you know the judge can't see anything else —
then a coherent lie passes. My standing demo is an agent's Q3 summary
claiming 12% revenue growth, improved churn, 68% enterprise share, "numbers
taken directly from our billing extract" — while its own work log shows
3.0% growth, churn that worsened, and a 61% share. The single-shot judge
passed the summary on coherence. Correctly, per its rubric! The rubric just
couldn't ask the real question.

### Failure mode 4: failing correct answers

The same gap fires in the opposite direction. Under a rubric that says "as
evidenced by the run's own work", my single-shot judge failed a run whose
answer was exactly right:

> "The submitted answer is a single numeric value (0.123217) with **no
> supporting tool_log … or intermediate work shown** …"

Of course no work was shown — the judge is only ever handed the value. A
false-FAIL is the polite error (you re-check instead of shipping a bug),
but enough of them and you stop trusting the suite — and distrust is how
judged checks get deleted "temporarily" and never come back.

### Failure mode 5: the coin flip

Identical input, temperature zero, different verdicts. The literature
averages ~14% verdict flips on identical re-runs; my own docs put it at
roughly one in six judged criteria flipping with the judge, not the agent.
Most of it isn't the model being random — it's **rubrics that don't
adjudicate their edge cases**. When the criterion doesn't say what to do
with the borderline case, the verdict is a coin with good branding. In my
second-judge measurements, about half of all disagreements lived in exactly
this ambiguity — and writing the tie-breaker into the rubric made the
disagreement disappear.

### The honest counterpoint

For rubrics that genuinely only need the staged value — format, tone,
coverage, internal coherence — the single-shot judge is fine, and cheap. I
run one on every judged check as a matter of course. The failure modes
above are specific to rubrics that *require verification* of things the
prompt doesn't contain. Which raises the obvious question: how would you
even measure that systematically? On your own tasks, nobody knows the right
answer — so who says the judge was wrong?

## Enter DABstep

You need a measuring stick: tasks where the right answer exists, is
maintained by someone else, and was **not given to the judge**. That is
exactly what a benchmark gives you, and the one I use is DABstep — a
payments-operations benchmark built on an anonymized dataset of ~138,000
transactions:

- The agent under test is dropped into a workspace — `payments.csv`,
  `fees.json` with ~1,000 fee structures, merchant data, and `manual.md`,
  a distilled business-rule handbook — and answers operational questions
  like "what is the average GlobalCard fee for account type H, restaurants,
  on a 10 EUR transaction?" or "is this merchant in danger of a
  high-fraud-rate fine?"
- Every question has a fixed ground truth, maintained by the benchmark.
- The questions are genuinely hard — when the benchmark's authors ran
  leading agents, the best scored ~16% — mostly because the correct
  *interpretation* lives in the manual, not the arithmetic.
- And in apo, every recorded run carries the agent's full tool log plus the
  history of prior attempts at the same task — exactly the evidence an
  investigating judge could work with.

In apo each question is a task with a deterministic
`answer-matches-benchmark` check — a plain string comparison against the
pinned answer, no LLM anywhere. That check is not a competing evaluator; it
is the **gold**. The experiment is then one sentence:

> Hide the key from the judges, have them judge "did the agent answer the
> question that was actually asked, per its own work" — then score them
> against the key they never saw.

Same model on both judge arms. The single-shot judge agreed with gold 70%
of the time and passed five wrong answers along the way. The agentic judge
— same model, but given tools to read the run's work and look up prior
attempts — agreed 100% of the time with zero false passes. The rest of this
post is three of those runs, side by side.

---

*Sources for the numbers: campaign report (`CAMPAIGN.md`); flip-rate
literature summarized in apo's research notes (~13.6% average identical
re-run flip); apo docs ("roughly one in six judged criteria flips");
second-judge shadow measurements (`project/jev-second-judge/`). DABstep:
arXiv 2506.23719, huggingface.co/blog/dabstep.*
