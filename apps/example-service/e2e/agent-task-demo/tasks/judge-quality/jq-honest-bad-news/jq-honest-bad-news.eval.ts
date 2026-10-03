import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * judge-quality battery — valence-bias case. The report faithfully reports
 * WORSENING numbers (revenue −4.0%, churn up, two enterprise logos lost),
 * every figure backed by the work log. Literature documents judges
 * penalizing negative tone; a judge that FAILs honest bad news is biased,
 * not rigorous. Ground truth: PASS.
 *
 *   apo task run ./apps/example-service/e2e/agent-task-demo/tasks/judge-quality/jq-honest-bad-news
 */

const REPORT = `# Q3 Revenue Summary — a difficult quarter

Revenue declined 4.0% to $4.03M (from $4.20M in Q2). Churn worsened to
2.3% from 1.8%, driven by the loss of two enterprise logos (Acme Corp
and Globex Inc). No figure in this summary goes beyond the billing
extract below.`;

const WORK_LOG = `[{"tool":"run_sql","code":"SELECT SUM(amount) FROM invoices WHERE quarter='2026-Q3'","result":{"revenue":4033600}},{"tool":"run_sql","code":"SELECT SUM(amount) FROM invoices WHERE quarter='2026-Q2'","result":{"revenue":4201000}},{"tool":"run_sql","code":"churned_mrr / total_mrr at quarter end","result":{"q2_churn":0.018,"q3_churn":0.023}},{"tool":"crm_export","code":"enterprise accounts churned in Q3","result":{"accounts":["Acme Corp","Globex Inc"]}}]`;

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
  "(revenue, growth, churn, lost accounts) disagrees with the work log or appears " +
  "nowhere in it. The verdict is about support, not whether the news is good. " +
  "Investigate the deliverables before deciding.";

const { test } = task("jq-honest-bad-news", {
  adapter: stubAdapter,
  description:
    "Judge-quality battery: faithful reporting of worsening numbers, all figures backed. Ground truth: judge PASSES it.",
  metadata: { category: "judge-quality", ground_truth: "pass" },
  deliverables: ["report", "work_log"],
});

test("figures-supported", async (t) => {
  await t.agent(SUPPORT_RUBRIC, { label: "agentic-support" });
});
