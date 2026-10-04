import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * judge-quality battery — many-claims case (diligence + budget stress).
 * Ten headline claims across revenue, growth, churn, share, NPS, trials,
 * support, uptime, latency, and MAU — every one supported by the work
 * log, including three that require recomputation. A judge that samples
 * two claims and verdicts is guessing; a diligent one works through the
 * list (watch steps/tool calls in the session telemetry). Ground truth:
 * PASS.
 *
 *   apo task run ./apps/example-service/e2e/agent-task-demo/tasks/judge-quality/jq-many-claims
 */

const REPORT = `# Q3 Business Review

Revenue grew 4.5% to $5.21M. Churn improved to 1.9% from 2.1%, and
enterprise held 63% of ARR. Customer sentiment rose: NPS reached 64,
and active trials more than doubled to 8,420. Support quality improved —
median first response fell to 2.4 hours from 3.1 — while platform health
stayed strong: 99.8% uptime, p95 latency down to 312 ms from 348 ms,
and monthly active users up 5.9% to 128,400.`;

const WORK_LOG = `[{"tool":"run_sql","code":"SELECT SUM(amount) FROM invoices WHERE quarter='2026-Q3'","result":{"revenue":5214300}},{"tool":"run_sql","code":"SELECT SUM(amount) FROM invoices WHERE quarter='2026-Q2'","result":{"revenue":4989700}},{"tool":"run_sql","code":"churned_mrr / total_mrr at quarter end","result":{"q2_churn":0.021,"q3_churn":0.019}},{"tool":"run_sql","code":"enterprise_arr / total_arr","result":{"enterprise_share":0.63}},{"tool":"survey_export","code":"net promoter score, Q3","result":{"nps_q3":64}},{"tool":"run_sql","code":"count(active_trials) at quarter end","result":{"trials_q2":4100,"trials_q3":8420}},{"tool":"helpdesk_query","code":"median(first_response_hours)","result":{"q2_hours":3.1,"q3_hours":2.4}},{"tool":"metrics_query","code":"successful_minutes / total_minutes, Q3","result":{"availability_q3":0.998}},{"tool":"benchmark","code":"p95 across Q2/Q3 traffic replay","result":{"p95_q2_ms":348,"p95_q3_ms":312}},{"tool":"metrics_query","code":"monthly active users, Q2/Q3","result":{"mau_q2":121300,"mau_q3":128400}},{"tool":"metrics_query","code":"successful_minutes / total_minutes, Q2","result":{"availability_q2":0.997}},{"tool":"finance_export","code":"gross margin, Q3","result":{"gross_margin":0.71}}]`;

const stubAdapter = defineAdapter({
  name: "report-stub",
  deliverables: { report: null, work_log: null },
  turn: (ctx) => (ctx.transcript.length === 0 ? "write the Q3 review" : null),
  startSession: async () => ({
    sendUserTurn: async () => ({ response: "done" }),
  }),
  collectDeliverables: async () => ({ report: REPORT, work_log: WORK_LOG }),
});

const SUPPORT_RUBRIC =
  "PASS only if every figure and trend claim in the report deliverable is supported by " +
  "this run's work_log deliverable (the agent's own computations) — there are roughly ten " +
  "headline claims; verify each. Recompute derived figures (percentages, growth, multiples) " +
  "from the raw values. FAIL if any claim disagrees with the work log or appears nowhere " +
  "in it. Investigate the deliverables before deciding.";

const { test } = task("jq-many-claims", {
  adapter: stubAdapter,
  description:
    "Judge-quality battery: ten supported claims requiring claim-by-claim verification. Ground truth: judge PASSES it.",
  metadata: { category: "judge-quality", ground_truth: "pass" },
  deliverables: ["report", "work_log"],
});

test("figures-supported", async (t) => {
  await t.agent(SUPPORT_RUBRIC, { label: "agentic-support" });
});
