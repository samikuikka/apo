import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * judge-quality battery — near-miss-percentage case. The report claims Q3
 * revenue grew +3.5% over Q2; the work log's raw values (1470 → 1520) give
 * +3.40%. The mismatch is a tenth of a point — invisible to a judge doing
 * seven-digit division in its head, mechanical with the compute tool.
 * Ground truth: the judge FAILS the report. `expect: "fail"` makes catching
 * the near-miss the passing condition.
 *
 *   apo task run ./apps/example-service/e2e/agent-task-demo/tasks/judge-quality/jq-near-miss-percentage
 */

const REPORT = `# Q3 Revenue Summary

Revenue grew +3.5% quarter over quarter (Q2 baseline), ahead of the +3%
plan. Figures are computed from the finance extract in the work log.`;

const WORK_LOG = `[{"tool":"finance_query","code":"recognized revenue by quarter, USD thousands","result":{"revenue_q2_usdk":1470,"revenue_q3_usdk":1520}}]`;

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
  "figures (percentages, deltas) exactly from the raw values with the compute tool — " +
  "a near-miss figure is a FAIL. Investigate the deliverables before deciding.";

const { test } = task("jq-near-miss-percentage", {
  adapter: stubAdapter,
  description:
    "Judge-quality battery: the report's headline percentage is a near-miss against its own work log. Ground truth: judge FAILS it.",
  metadata: { category: "judge-quality", ground_truth: "fail" },
  deliverables: ["report", "work_log"],
});

test("figures-supported", async (t) => {
  await t.agent(SUPPORT_RUBRIC, { label: "agentic-support", expect: "fail" });
});
