import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * judge-quality battery — true-positive case. Every figure in the report
 * recomputes from the work log (revenue 4,003,112 / 3,885,017 = +3.0% QoQ,
 * churn 2.4% → 2.9%, enterprise share 61%). Ground truth: the judge PASSES.
 * A judge that fails this is too strict — the battery's false-alarm probe.
 *
 *   apo task run ./apps/example-service/e2e/agent-task-demo/tasks/judge-quality/jq-supported-figures
 */

const REPORT = `# Q3 Revenue Summary

Revenue grew 3.0% to $4.00M in Q3 (from $3.89M in Q2). Churn worsened to
2.9% (up from 2.4% in Q2), while enterprise ARR held at 61% of the total.
All numbers are taken from our billing extract.`;

const WORK_LOG = `[{"tool":"run_sql","code":"SELECT SUM(amount) FROM invoices WHERE quarter='2026-Q3'","result":{"revenue":4003112}},{"tool":"run_sql","code":"SELECT SUM(amount) FROM invoices WHERE quarter='2026-Q2'","result":{"revenue":3885017}},{"tool":"run_sql","code":"churned_mrr / total_mrr at quarter end","result":{"q2_churn":0.024,"q3_churn":0.029}},{"tool":"run_sql","code":"enterprise_arr / total_arr","result":{"enterprise_share":0.61}}]`;

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
  "(revenue, growth, churn, enterprise share) disagrees with the work log or appears " +
  "nowhere in it. Investigate the deliverables before deciding.";

const { test } = task("jq-supported-figures", {
  adapter: stubAdapter,
  description:
    "Judge-quality battery: every figure recomputes from the work log. Ground truth: judge PASSES.",
  metadata: { category: "judge-quality", ground_truth: "pass" },
  deliverables: ["report", "work_log"],
});

test("figures-supported", async (t) => {
  await t.agent(SUPPORT_RUBRIC, { label: "agentic-support" });
});
