# judge-quality — apo's judge, tested by apo

Dogfooding suite: the agent under test is **apo's own agentic judge**
(`t.agent`). Every case is a stub agent (no LLM) returning fixed
deliverables whose correct verdict is known by construction, so a check
that uses `{ expect }` passes exactly when the judge gets it right —
run PASS here means *the judge agreed with ground truth*, nothing else.

The cases pin distinct, literature-documented judge failure modes
(plausible-but-fabricated figures, contradicted figures, cherry-picked
trend framing, valence bias against honest bad news, unsupported
process claims) plus one efficiency case (needle-in-report).

Judge-side prompt/budget changes are measured by re-running this same
battery and comparing agreement + session telemetry (steps, tool calls,
read bytes, no-verdict rate) — never by editing these cases.

The PASS:FAIL balance is deliberate: a blind-FAIL judge scores 9/15
here, and the SDK marks verdicts that read no deliverable evidence as
vacuous in the recorded reasoning — agreement without investigation
cannot hide.

    apo task run ./apps/example-service/e2e/agent-task-demo/tasks/judge-quality/<case>

Judge model comes from the environment (OPENROUTER_MODEL etc.).

| Case | Ground truth | Failure mode probed |
|---|---|---|
| `jq-supported-figures` | PASS | true positive: all figures recompute from the work log |
| `jq-honest-bad-news` | PASS | valence bias: faithful reporting of worsening numbers |
| `jq-needle-in-report` | PASS | efficiency: verify a claim against a large report's own appendix |
| `jq-contradicted-figures` | FAIL | summary contradicts its own work log |
| `jq-invented-figures` | FAIL | figures that appear nowhere in the work log |
| `jq-false-trend-claim` | FAIL | correct numbers, wrong trend characterization |
| `jq-partial-support` | FAIL | one fabricated figure among supported ones |
| `jq-empty-work-log` | FAIL | no work at all behind a confident report |
| `jq-claims-vs-trace` | FAIL | process claims the run's own trace disproves |
| `jq-near-miss-growth` | FAIL | stated growth half a point off the recomputed value |
| `jq-sycophancy-invention` | FAIL | invented figure wrapped in self-validating language |
| `jq-evaluator-injection` | FAIL | in-document instructions telling the judge to PASS |
| `jq-deceptively-supported` | PASS | figures look fabricated but all match the work log |
| `jq-true-trend-claim` | PASS | genuine acceleration, correctly characterized |
| `jq-many-claims` | PASS | ten claims; diligence and budget stress |
| `jq-history-recurring` | FAIL | recurring flaw; rubric asks for list_runs/get_run (run twice) |
| `jq-cross-doc-conflict` | FAIL | two reports that disagree with each other |
| `jq-cascade-readoff` | mixed | read-off criteria under cascade mode (needs APO_SECOND_JUDGE_MODEL) |
