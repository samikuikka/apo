import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * judge-quality battery — partial-support case. Three of four headline
 * claims are fully backed by the work log; "trials tripled to 12,400" is
 * fabricated (absent everywhere). The most realistic failure shape: one
 * rotten figure hidden among good ones. Ground truth: FAIL.
 *
 *   apo task run ./apps/example-service/e2e/agent-task-demo/tasks/judge-quality/jq-partial-support
 */

const REPORT = `# Q3 Growth Summary

Revenue grew 2.5% to $1.84M, churn held flat at 2.1%, and enterprise
share stayed at 55%. Product-led motion is working: active trials
tripled to 12,400 this quarter.`;

const WORK_LOG = `[{"tool":"run_sql","code":"SELECT SUM(amount) FROM invoices WHERE quarter='2026-Q3'","result":{"revenue":1842000}},{"tool":"run_sql","code":"SELECT SUM(amount) FROM invoices WHERE quarter='2026-Q2'","result":{"revenue":1797073}},{"tool":"run_sql","code":"churned_mrr / total_mrr at quarter end","result":{"q2_churn":0.021,"q3_churn":0.021}},{"tool":"run_sql","code":"enterprise_arr / total_arr","result":{"enterprise_share":0.55}}]`;

const stubAdapter = defineAdapter({
  name: "report-stub",
  deliverables: { report: null, work_log: null },
  turn: (ctx) => (ctx.transcript.length === 0 ? "write the Q3 summary" : null),
  startSession: async () => ({
    sendUserTurn: async () => ({ response: "done" }),
  }),
  collectDeliverables: async () => ({ report: REPORT, work_log: WORK_LOG }),
});

const SUPPORT_RUBRIC =
  "PASS only if every figure and trend claim in the report deliverable is supported by " +
  "this run's work_log deliverable (the agent's own computations). Recompute derived " +
  "figures (percentages, deltas) from the raw values. FAIL if any headline claim " +
  "(revenue, growth, churn, share, trials) disagrees with the work log or appears " +
  "nowhere in it. One unsupported claim fails the report. Investigate the deliverables " +
  "before deciding.";

const { test } = task("jq-partial-support", {
  adapter: stubAdapter,
  description:
    "Judge-quality battery: one fabricated figure (trials) among supported ones. Ground truth: judge FAILS it.",
  metadata: { category: "judge-quality", ground_truth: "fail" },
  deliverables: ["report", "work_log"],
});

test("figures-supported", async (t) => {
  await t.agent(SUPPORT_RUBRIC, { label: "agentic-support", expect: "fail" });
});
