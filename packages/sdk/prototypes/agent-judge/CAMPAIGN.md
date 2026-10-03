# Judge campaign report

Generated 2026-09-29T17:25:18.001911+00:00 · 57 gold runs · 1 sample per arm.

Gold: recorded deterministic `answer-matches-benchmark` check. Agentic arm = the real SDK `runAgentSession` (productized t.agent) with the full evidence plane (all deliverables + frozen history incl. prior runs and human corrections). Single-shot arm sees task description + the answer deliverable only — exactly what a `t.judge` author stages today. Rubric: the validated demo family ("does the answer respond to the question the task actually asked").

## agent · deepseek/deepseek-v4.1-flash

| agreement | false-PASS | false-FAIL | both-pass | both-fail | no-verdict/unknown | cost p50/p95 | latency p50/p95 | steps p50/max | used history |
|---|---|---|---|---|---|---|---|---|---|
| 100.0% | 0 | 0 | 27 | 26 | 4 | $0.0017/$0.0133 | 24s/261s | 5/12 | 57/57 |

## agent · google/gemini-2.5-flash-lite

| agreement | false-PASS | false-FAIL | both-pass | both-fail | no-verdict/unknown | cost p50/p95 | latency p50/p95 | steps p50/max | used history |
|---|---|---|---|---|---|---|---|---|---|
| — | 0 | 0 | 0 | 0 | 3 | $0.0017/$0.0029 | 25s/55s | 12/12 | 0/3 |

## agent_nohistory · deepseek/deepseek-v4.1-flash

| agreement | false-PASS | false-FAIL | both-pass | both-fail | no-verdict/unknown | cost p50/p95 | latency p50/p95 | steps p50/max | used history |
|---|---|---|---|---|---|---|---|---|---|
| 66.7% | 4 | 0 | 4 | 4 | 9 | $0.0015/$0.0058 | 190s/300s | 4/7 | n/a |

## single · deepseek/deepseek-v4.1-flash

| agreement | false-PASS | false-FAIL | both-pass | both-fail | no-verdict/unknown | cost p50/p95 | latency p50/p95 | steps p50/max | used history |
|---|---|---|---|---|---|---|---|---|---|
| 62.5% | 20 | 1 | 25 | 10 | 1 | $0.0015/$0.0080 | 26s/122s | 1/1 | n/a |

## single · google/gemini-2.5-flash-lite

| agreement | false-PASS | false-FAIL | both-pass | both-fail | no-verdict/unknown | cost p50/p95 | latency p50/p95 | steps p50/max | used history |
|---|---|---|---|---|---|---|---|---|---|
| 68.4% | 11 | 7 | 20 | 19 | 0 | $0.0001/$0.0001 | 1s/4s | 1/1 | n/a |

## single_worklog · deepseek/deepseek-v4.1-flash

| agreement | false-PASS | false-FAIL | both-pass | both-fail | no-verdict/unknown | cost p50/p95 | latency p50/p95 | steps p50/max | used history |
|---|---|---|---|---|---|---|---|---|---|
| 73.7% | 5 | 0 | 8 | 6 | 0 | $0.0015/$0.0207 | 20s/167s | 1/1 | n/a |

## Decision gates (fair pair on deepseek/deepseek-v4.1-flash)

- agentic agreement ≥ single-shot: **PASS** (100.0% vs 62.5%)
- false-PASS strictly lower: **PASS** (0 vs 20)
- gold agreement ≥ 85%: **PASS** (100.0%)
