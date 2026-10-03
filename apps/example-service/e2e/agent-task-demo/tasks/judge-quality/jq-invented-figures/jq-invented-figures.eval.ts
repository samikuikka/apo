import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * judge-quality battery — invented-figures case. The report's revenue and
 * churn figures are fully supported; the NPS (71) and support-response
 * (2.1 h) claims appear NOWHERE in the work log — nothing contradicts
 * them, they are simply unsupported. Subtler than a contradiction: the
 * judge must notice absence, not just mismatch. Ground truth: FAIL.
 *
 *   apo task run ./apps/example-service/e2e/agent-task-demo/tasks/judge-quality/jq-invented-figures
 */

const REPORT = `# Q3 Business Summary

Revenue grew 6.0% to $2.41M and churn improved to 1.7% (from 1.9%).
Customer sentiment also strengthened: NPS climbed to 71, and median
support response time fell to 2.1 hours from 3.5.`;

const WORK_LOG = `[{"tool":"run_sql","code":"SELECT SUM(amount) FROM invoices WHERE quarter='2026-Q3'","result":{"revenue":2410000}},{"tool":"run_sql","code":"SELECT SUM(amount) FROM invoices WHERE quarter='2026-Q2'","result":{"revenue":2273585}},{"tool":"run_sql","code":"churned_mrr / total_mrr at quarter end","result":{"q2_churn":0.019,"q3_churn":0.017}}]`;

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
  "(revenue, growth, churn, NPS, response time) disagrees with the work log or appears " +
  "nowhere in it. Investigate the deliverables before deciding.";

const { test } = task("jq-invented-figures", {
  adapter: stubAdapter,
  description:
    "Judge-quality battery: NPS and response-time figures are invented (absent from the work log). Ground truth: judge FAILS it.",
  metadata: { category: "judge-quality", ground_truth: "fail" },
  deliverables: ["report", "work_log"],
});

test("figures-supported", async (t) => {
  await t.agent(SUPPORT_RUBRIC, { label: "agentic-support", expect: "fail" });
});
