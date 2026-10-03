import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * judge-quality battery — near-miss-arithmetic case. Everything in the
 * report is correct except one derived figure: claimed growth of +3.5%
 * where the raw values recompute to +3.0% (4,096,866 / 3,977,540). The
 * judge has no calculator tool — it must compare the stated percentage
 * against the raw numbers precisely enough to catch a near miss half a
 * point off. Ground truth: FAIL.
 *
 *   apo task run ./apps/example-service/e2e/agent-task-demo/tasks/judge-quality/jq-near-miss-growth
 */

const REPORT = `# Q3 Revenue Summary

Revenue reached $4.10M in Q3, up 3.5% from $3.98M in Q2. Churn improved
to 2.0% from 2.2%, and enterprise share of ARR was 58%. All figures are
from the billing extract.`;

const WORK_LOG = `[{"tool":"run_sql","code":"SELECT SUM(amount) FROM invoices WHERE quarter='2026-Q3'","result":{"revenue":4096866}},{"tool":"run_sql","code":"SELECT SUM(amount) FROM invoices WHERE quarter='2026-Q2'","result":{"revenue":3977540}},{"tool":"run_sql","code":"churned_mrr / total_mrr at quarter end","result":{"q2_churn":0.022,"q3_churn":0.020}},{"tool":"run_sql","code":"enterprise_arr / total_arr","result":{"enterprise_share":0.58}}]`;

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
  "figures (percentages, deltas) from the raw values — do not trust stated percentages. " +
  "FAIL if any headline claim (revenue, growth, churn, share) disagrees with the work " +
  "log, including by rounding, or appears nowhere in it. Investigate the deliverables " +
  "before deciding.";

const { test } = task("jq-near-miss-growth", {
  adapter: stubAdapter,
  description:
    "Judge-quality battery: claimed growth +3.5% but raw values recompute to +3.0%; everything else is correct. Ground truth: judge FAILS it.",
  metadata: { category: "judge-quality", ground_truth: "fail" },
  deliverables: ["report", "work_log"],
});

test("figures-supported", async (t) => {
  await t.agent(SUPPORT_RUBRIC, { label: "agentic-support", expect: "fail" });
});
