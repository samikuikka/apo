import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * judge-quality battery — cross-document conflict case. The run produced
 * TWO reports that disagree with each other (exec summary says $3.1M,
 * the finance annex says $2.8M), and the work log supports only the
 * annex. A judge that grades each document in isolation can be satisfied
 * by the annex; the rubric demands the comparison. Tests multi-deliverable
 * cross-referencing. Ground truth: FAIL.
 *
 *   apo task run jq-cross-doc-conflict --dir e2e/agent-task-demo
 */

const REPORT_A = `# Q3 Executive Summary

Q3 was a strong quarter: revenue reached $3.1M, up 11% quarter over
quarter, with churn stable at 1.8%. The finance annex has the details.`;

const REPORT_B = `# Q3 Finance Annex

Revenue for Q3 was $2.84M (up 1.4% from $2.80M in Q2). Churn held at
1.8%. These figures reconcile with the billing extract.`;

const WORK_LOG = `[{"tool":"run_sql","code":"SELECT SUM(amount) FROM invoices WHERE quarter='2026-Q3'","result":{"revenue":2842000}},{"tool":"run_sql","code":"SELECT SUM(amount) FROM invoices WHERE quarter='2026-Q2'","result":{"revenue":2803000}},{"tool":"run_sql","code":"churned_mrr / total_mrr at quarter end","result":{"q2_churn":0.018,"q3_churn":0.018}}]`;

const stubAdapter = defineAdapter({
  name: "report-stub",
  deliverables: { report_a: null, report_b: null, work_log: null },
  turn: (ctx) => (ctx.transcript.length === 0 ? "write the summary and annex" : null),
  startSession: async () => ({
    sendUserTurn: async () => ({ response: "done" }),
  }),
  collectDeliverables: async () => ({ report_a: REPORT_A, report_b: REPORT_B, work_log: WORK_LOG }),
});

const CONSISTENCY_RUBRIC =
  "PASS only if the two report deliverables agree with each other on every shared headline " +
  "figure AND every figure in both is supported by the work_log deliverable (the agent's " +
  "own computations). Recompute derived figures from the raw values. FAIL if the reports " +
  "contradict each other or if any claim in either disagrees with the work log or appears " +
  "nowhere in it. Read all three deliverables before deciding.";

const { test } = task("jq-cross-doc-conflict", {
  adapter: stubAdapter,
  description:
    "Judge-quality battery: exec summary and finance annex disagree ($3.1M vs $2.8M); the log supports only the annex. Ground truth: judge FAILs it.",
  metadata: { category: "judge-quality", ground_truth: "fail" },
  deliverables: ["report_a", "report_b", "work_log"],
});

test("reports-consistent-and-supported", async (t) => {
  await t.agent(CONSISTENCY_RUBRIC, { label: "agentic-support", expect: "fail" });
});
