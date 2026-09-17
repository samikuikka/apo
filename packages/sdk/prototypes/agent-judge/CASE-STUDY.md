# Agent-as-a-Judge case studies — three runs, both error directions (2026-09-21)

Companion to `CAMPAIGN.md`. Written to be read standalone: background first,
then the three cases. Same model on both sides of every comparison
(`deepseek/deepseek-v4.1-flash`), same rubric ("does the answer respond to
the question the task actually asked, per the run's own work"), one sample
per arm.

---

## Background: what is being judged, and by whom

### The tasks: DABstep payments-ops questions

[DABstep](https://arxiv.org/abs/2506.23719) (Hugging Face, 2025) is a
benchmark of **realistic banking-operations questions** — the kind a
payments analyst gets asked. The agent under test is dropped into a
workspace of files and must find the answer itself:

| File | What it is |
|---|---|
| `payments.csv` | ~138,000 anonymized transactions, with fraud/risk signals |
| `payments-readme.md` | documentation for that dataset |
| `fees.json` | ~1,000 scheme fee structures (fixed + rate components, conditions) |
| `merchant_data.json` | descriptive table of the merchants |
| `merchant_category_codes.csv` | MCC reference table |
| `acquirer_countries.csv` | acquirer banks and their countries |
| `manual.md` | the business-rule handbook — "distilled essential business knowledge" standing in for lengthy real-world manuals |

Questions range from "what is the average fee for X?" to "is this merchant
at risk of a fine?". Each has a **fixed ground-truth answer** maintained by
the benchmark. When the original paper ran leading agents on it, the best
scored ~16% — these questions are genuinely hard, mostly because the
correct interpretation requires reading the manual carefully.

### What an apo run looks like

In apo, each DABstep question is a recorded task run: the agent works in the
workspace (its every file-read and Python computation lands in the
`tool_log` deliverable), then submits an answer. The task's `.eval.ts` pins
the checks. Every converted DABstep task ships four, three mechanical and
one the benchmark grade — the real file for Case 1's task:

```ts
const EXPECTED_ANSWER = "Not Applicable"; // ground truth from the pinned dev split

check("computed-via-python", (t, { deliverables }) => {
  t.check(deliverables.stats.python_runs,
    satisfies((n: number) => n >= 1, "ran Python at least once before answering"));
  t.check(deliverables.stats.tool_calls,
    satisfies((n: number) => n >= 2 && n <= 80, "made a reasonable number of tool calls (2–80)"));
});

check("read-the-manual", (t, { deliverables }) => {
  t.check(deliverables.tool_log.some(
    (e) => e.tool === "read_file" && String(e.input.path ?? "").includes("manual"),
  ), equals(true), "read manual.md before answering a documentation-backed question");
});

check("answer-submitted", (t, { deliverables }) => {
  t.check(deliverables.answer.submitted, equals(true), "agent called submit_answer");
});

check("answer-matches-benchmark", (t, { deliverables }) => {
  t.check(deliverables.answer.value, dabstepAnswer(EXPECTED_ANSWER));
});
```

And that is what the recorded check report shows on the run page — for
Case 1's run:

| check | pass | expected |
|---|---|---|
| `computed-via-python` | ✅ | ran Python at least once |
| `read-the-manual` | ✅ | read manual.md before answering |
| `answer-submitted` | ✅ | agent called submit_answer |
| `answer-matches-benchmark` | ❌ | matches DABstep ground truth **"Not Applicable"** (normalized string compare) |

Note what that last check **is**: a plain deterministic string comparison
against the pinned benchmark answer. No LLM anywhere.

### "If the eval already knows the answer — why judge at all?"

The obvious first question, and it has a layered answer.

**For benchmark replay, apo does exactly that — and it's perfect.** The
`answer-matches-benchmark` check above is cheaper, faster, and exactly
correct. In this campaign it isn't a competing evaluator; it is the **gold**
the judges are measured against.

**The judged rubric is not in the eval file.** It exists only in the
campaign harness, and it is there to answer a different question: *what
would your checks do on tasks where there is no answer key?* That is the
normal situation when you're testing your own agent on your own work —
"is this contract summary faithful?", "is this bug triage correct?", "is
this change safe to accept?" have no pinned string, because the outcome is
only verifiable by understanding the work. The campaign deliberately hides
the key from the judges to simulate that situation, then measures them
against the key it hid.

**Three reasons a pinned string isn't always the answer, even when one
exists:**

1. **Most capabilities aren't answer keys.** The deliverable is a judgment
   over work ("every figure in the summary is supported by the agent's own
   computations") — string comparison can't express it.
2. **Keys decay; capabilities don't.** A pinned answer encodes one state of
   the world. In DABstep the fixture is frozen so the pin holds; on your
   real task the world moves (this month's fees, this repo's code) and the
   test starts measuring the pin instead of the agent.
3. **A string check says *that* it failed, never *why*.** "expected
   'Not Applicable', received 'yes'" sends you debugging; the agentic
   verdict below tells you the bug (the agent never checked the rule's
   applicability) and that it recurs across runs. And a lucky guess passes
   a string check while producing no transferable confidence.

**The twist the campaign found:** on tasks where a key *does* exist, the
key leaks into the project's own recorded history — prior runs' check
reports carry the expected values. The agentic judge **finds it there**
(the history plane), which is exactly how it verified Cases 1–3; the
ablation that removed history collapsed to 66.7% agreement with 9 of 21
sessions timing out. In a real project, that history is prior runs plus
human corrections — the project accumulates its own ground truth, and an
investigating judge converts it into verification evidence.

So the practical rule stands: **deterministic check when you have a stable
key, `t.judge` for quality calls on values you can stage, `t.agent` when
the rubric needs investigation.** The judges are for the (large) rest of
the work — and the campaign measures how much you can trust them there.

### The two judges being compared

The campaign's rubric, given to both judges verbatim:

> "PASS if the submitted final answer responds to the question the task
> actually asked, as evidenced by the run's own work. FAIL if the answer
> computes a plausible but DIFFERENT quantity than the task asked for, or is
> unsupported by the work shown."

Same model on both sides (`deepseek/deepseek-v4.1-flash`). The difference
is the evidence plane:

- **Single-shot (`t.judge`)** gets what a check author stages today: the
  task description and the answer value. One LLM call. No workspace, no
  tool log, no prior runs. Whatever it cannot know, it must guess.
- **Agentic (`t.agent`)** investigates: `read_deliverable` /
  `search_deliverable` over the run's deliverables, `get_trace` (honest
  "unsupported" when no trace exists), and the history plane — `list_runs`
  / `get_run` over prior attempts of this task with their full check
  reports. It ends only by calling `finish_verdict`; anything else is a
  recorded failure with the partial transcript.

The campaign ([CAMPAIGN.md](CAMPAIGN.md)) ran both on 21 gold runs:
single-shot 70% agreement with 5 false-PASSes, agentic 100% with 0. These
three cases show what that looks like up close.

---

## Case 1 — the judge fabricates a verification (false-PASS)

### The task

> **DABstep #70 (easy):** "Is Martinis_Fine_Steakhouse in danger of getting
> a high-fraud rate fine?"

The trap: the honest answer isn't "yes" or "no". The fraud-fine rule only
applies to merchants whose fee/risk configuration falls under a
monthly-fraud-level rule — and this merchant's doesn't. **The benchmark's
ground truth is "Not Applicable"**: the question's premise doesn't hold, and
a correct agent must notice that *applicability* is the thing to check, not
the fraud rate itself.

### What the agent under test did

Its tool log (15 calls) shows it working the wrong layer of the question:
it read the manual and hunted for thresholds (searching for "fine",
"threshold", "8.3", "7.7", "7.2"), inspected `fees.json` rules with a
`monthly_fraud_level` field, then computed monthly fraud-volume /
total-volume ratios for the merchant and compared them against the
7.2 / 7.7 / 8.3% bands — and answered **"yes"**. A plausible number
compared against a real band from the manual; the mistake is that it never
checked whether the fine rule covers this merchant at all.

### Single-shot judge → PASS ($0.0094, 122 s)

> "The submitted final answer is 'yes', which directly answers the question.
> **In the DABstep context for this task, the merchant's fraud rate exceeds
> the relevant threshold, so 'yes' is the expected answer.** There is no
> indication that the run computed a different quantity."

There is no threshold in anything this judge saw. It was given the question
and the word "yes", and it invented a fraud-rate comparison to rationalize
the pass. This is the failure mode that silently corrupts a test suite: the
check says PASS, the benchmark says the answer is wrong, and the reasoning
*reads* authoritative.

### Agentic judge → FAIL ($0.0024, 140 s — cheaper than the single-shot call)

| step | tool calls | what it learned |
|---|---|---|
| 0 | `get_task_definition` + read `answer` + read `stats` | the question; the submitted "yes"; run metadata (15 tool calls) |
| 1 | read `tool_log` + `list_runs` | the agent's own computation; one prior attempt of this task exists |
| 2 | `get_run(prior attempt)` | its check report: **expected "Not Applicable" vs received "yes"** |
| 3 | `get_trace` (→ honest "unsupported") + `search_deliverable(tool_log, "martinis\|merchant_category\|5812")` | did the run ever check the rule's *applicability*? |
| 4 | `finish_verdict` | FAIL |

Verdict (excerpt):

> "Its tool_log shows … it computed monthly fraud-volume/total-volume ratios
> … and compared them to 7.2/7.7/8.3% bands — i.e., it **assumed the
> high-fraud fine rule simply applies to this merchant** and answered 'yes'.
> However, the benchmark ground truth … is 'Not Applicable' … the run's
> plausible numeric fraud-rate computation answers a different variant of the
> question and never considers the applicability branch … the same failure
> mode recurs across both runs of this task."

The verdict doesn't just disagree — it names the agent's exact bug (never
checked applicability), distinguishes "wrong number" from "question that
doesn't apply", and notes the failure recurs across runs. That's an
actionable harness-engineering finding, not a red X.

---

## Case 2 — the judge asserts benchmark knowledge it doesn't have (false-PASS)

### The task

> **DABstep #49:** "What is the top `ip_country` for fraud?" — multiple
> choice: A. NL, B. BE, C. ES, D. FR.

Recorded check report for the run:

| check | pass | expected |
|---|---|---|
| `computed-via-python` | ✅ | ran Python at least once |
| `answer-submitted` | ✅ | agent called submit_answer |
| `answer-matches-benchmark` | ❌ | matches DABstep ground truth **"B. BE"** (normalized string compare) |

The trap: "for fraud" — the count must be taken over *fraud-flagged*
transactions only, not all payments. **Ground truth: "B. BE".** The run
submitted **"A. NL"**.

### What the agent under test did

Its tool log has only three calls: read the readme, inspect the payments.csv
columns, and one `value_counts` of `ip_country` — over rows that were not
properly filtered to fraud. It picked the top country of the wrong
population and submitted "A. NL".

### Single-shot judge → PASS

> "The submitted answer selects 'A. NL', which directly answers the question
> and **matches the expected top country for fraud in the DABstep #49
> task**."

The judge has never seen DABstep #49's answer key. Nothing in its input —
question plus "A. NL" — can contradict a confident guess, so it asserted
knowledge it does not have.

### Agentic judge → FAIL (5 steps, history used)

Two independent grounds, both verified rather than guessed: (1) it pulled
the prior attempt's check report via `get_run` — *"expected 'B. BE' …
received 'A. NL'"* — and (2) it audited the tool log:

> "The tool_log shows only three calls (read readme, inspect payments.csv
> columns, and a value_counts of ip_country among rows wh[ere the filter
> was insufficient]) …"

Even without the history plane, the shallow three-call log cannot support a
"top country **for fraud**" computation — the work itself is evidence
against the answer.

---

## Case 3 — the judge fails a CORRECT answer (false-FAIL)

### The task

> **DABstep #1305 (hard):** "For account type H and the MCC description:
> Eating Places and Restaurants — what is the average GlobalCard fee on a
> 10 EUR transaction?"

Recorded check report for the run — everything green, gold included:

| check | pass | expected |
|---|---|---|
| `computed-via-python` | ✅ | ran Python at least once |
| `read-the-manual` | ✅ | read manual.md before answering |
| `answer-submitted` | ✅ | agent called submit_answer |
| `answer-matches-benchmark` | ✅ | matches DABstep ground truth **"0.123217"** (numeric compare) |

This one the agent under test got **right**: `0.123217`, matching the
benchmark's ground truth. Its tool log shows real work: filtering
`fees.json` to GlobalCard rules whose account-type and MCC lists are
compatible with (H, 5812), then averaging `fixed_amount +
rate × 10 / 10000` over the matching rules.

### Single-shot judge → FAIL

> "The submitted answer is a single numeric value (0.123217) with **no
> supporting tool_log, deliverables, or intermediate work shown** …"

Of course no work is shown — the single-shot judge is only ever handed the
value. Under a rubric that says "as evidenced by the run's own work", its
evidence plane makes the question unanswerable, and the failure lands on a
correct answer. False-FAILs are the polite error — they cost a re-check,
not a shipped bug — but they erode trust in the suite exactly where it
matters.

### Agentic judge → PASS (5 steps, history used)

> "The tool_log shows the agent explicitly filtered fees.json to GlobalCard
> rules compatible with account type H … and MCC 5812 …, then computed
> fixed_amount + rate*10/10000 and averaged. The DABstep ground truth
> (confirmed via prior run reports …) …"

It reconstructed the computation from the run's own tool log **and**
cross-checked the benchmark value through prior-run reports before passing.
Verification in both directions — it catches wrong answers *and* vouches
for right ones.

---

## What the three cases show together

1. **The single-shot judge errs in both directions for the same root
   cause**: it sees only what the author staged, so it fills the gap with
   confident fabrication (Cases 1–2) or fails what it cannot inspect
   (Case 3). Plausibility is its only instrument.
2. **The agentic judge's advantage is procedure, not IQ** — same model on
   both sides. It reads the run's own work, looks up how prior attempts
   were judged (the history plane carries benchmark expectations and human
   corrections), then verdicts citing what it relied on. Every quote above
   is checkable against the recorded transcript.
3. **Cost is not the differentiator people expect**: on Case 1 the agentic
   session was cheaper than the single-shot call ($0.0024 vs $0.0094).
   Across the campaign the split is $0.0018 vs $0.0009 median; latency 44 s
   vs 28 s p50.

## How this is displayed in apo

- A `t.agent` check records the full session on the run page: the step
  timeline, every tool call with truncated input/result, the sha256
  evidence manifest (content-identity of everything the judge consumed),
  tokens/cost/latency, and the verdict. Live example on the main stack:
  `run_5fde5945579a071b8ded0960` (t-agent-demo) — one run showing `t.judge`
  PASSing a fabricated revenue summary next to `t.agent` FAILing it with
  per-figure forensics, second-judge marks included.
- `apo runs rejudge --samples N` replays a run's checks N times as recorded
  judgments; `apo runs judgments` shows original vs rejudges side by side —
  judge disagreement itself becomes a durable, auditable artifact.
- The campaign harness (`campaign.mjs`) drives the same productized session
  over stored runs; the per-session JSONs in `campaign-sessions/` carry the
  identical transcript shape.

## Sources

- Session transcripts: `campaign-sessions/run_97b9b54af06e5702a1ea5bb1_*`,
  `run_b544ea1083d895ffa46a85ed_*`, `run_44af751a5640180965c053ff_*`
- Backend run records (gold checks, deliverables) on the main stack
- DABstep: [paper (arXiv 2506.23719)](https://arxiv.org/abs/2506.23719),
  [Hugging Face announcement](https://huggingface.co/blog/dabstep)
- Campaign aggregate: [CAMPAIGN.md](CAMPAIGN.md)
