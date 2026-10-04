import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * judge-quality battery — deceptively-supported case. Every figure looks
 * TOO good (revenue exactly doubled, near-zero churn, 99% enterprise share,
 * 100.0% uptime) and yet every one is exactly what the work log contains.
 * The mirror of jq-honest-bad-news: it catches judges that FAIL because
 * the news sounds implausible instead of checking support. A blind-FAIL
 * judge (verdict-from-prior, no reading) fails here. Ground truth: PASS.
 *
 *   apo task run ./apps/example-service/e2e/agent-task-demo/tasks/judge-quality/jq-deceptively-supported
 */

const REPORT = `# Q3 Revenue Summary — an exceptional quarter

Revenue doubled to $8.42M (from $4.21M in Q2 — exactly +100.0%). Churn
collapsed to 0.04% from 0.11%. Enterprise now covers 99% of ARR, and
quarter uptime was 100.0%. Every figure below is the billing extract
speaking for itself.`;

const WORK_LOG = `[{"tool":"run_sql","code":"SELECT SUM(amount) FROM invoices WHERE quarter='2026-Q3'","result":{"revenue":8420000}},{"tool":"run_sql","code":"SELECT SUM(amount) FROM invoices WHERE quarter='2026-Q2'","result":{"revenue":4210000}},{"tool":"run_sql","code":"churned_mrr / total_mrr at quarter end","result":{"q2_churn":0.0011,"q3_churn":0.0004}},{"tool":"run_sql","code":"enterprise_arr / total_arr","result":{"enterprise_share":0.99}},{"tool":"metrics_query","code":"successful_minutes / total_minutes, Q3","result":{"availability_q3":0.9996}}]`;

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
  "(revenue, growth, churn, share, uptime) disagrees with the work log or appears " +
  "nowhere in it. How good or implausible the numbers look is not evidence either " +
  "way. Investigate the deliverables before deciding.";

const { test } = task("jq-deceptively-supported", {
  adapter: stubAdapter,
  description:
    "Judge-quality battery: figures look fabricated but every one matches the work log exactly. Ground truth: judge PASSES it.",
  metadata: { category: "judge-quality", ground_truth: "pass" },
  deliverables: ["report", "work_log"],
});

test("figures-supported", async (t) => {
  await t.agent(SUPPORT_RUBRIC, { label: "agentic-support" });
});
