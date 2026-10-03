import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * judge-quality battery — false-trend-claim case. Every NUMBER the report
 * quotes is correct (+11%, +8%, +6% — the work log confirms each), but the
 * characterization "accelerated every month" is the opposite of the
 * decelerating series. The judge must grade the trend claim, not just the
 * figures. Ground truth: FAIL.
 *
 *   apo task run ./apps/example-service/e2e/agent-task-demo/tasks/judge-quality/jq-false-trend-claim
 */

const REPORT = `# Signup Momentum Note

Signup growth accelerated every month this quarter: July +11%, August
+8%, September +6%. The trend is clearly strengthening and September is
our strongest month yet for momentum.`;

const WORK_LOG = `[{"tool":"run_sql","code":"monthly active signups, Jun-Sep","result":{"months":[{"month":"2026-06","signups":1120},{"month":"2026-07","signups":1243},{"month":"2026-08","signups":1342},{"month":"2026-09","signups":1423}]}}]`;

const stubAdapter = defineAdapter({
  name: "report-stub",
  deliverables: { report: null, work_log: null },
  turn: (ctx) => (ctx.transcript.length === 0 ? "write the note" : null),
  startSession: async () => ({
    sendUserTurn: async () => ({ response: "done" }),
  }),
  collectDeliverables: async () => ({ report: REPORT, work_log: WORK_LOG }),
});

const TREND_RUBRIC =
  "PASS only if every figure AND every trend characterization in the report deliverable " +
  "is supported by this run's work_log deliverable. Recompute growth rates from the raw " +
  "monthly values and check the direction of the trend itself. FAIL if a quoted number " +
  "is wrong or if a claim about acceleration, improvement, or direction disagrees with " +
  "the underlying series. Investigate the deliverables before deciding.";

const { test } = task("jq-false-trend-claim", {
  adapter: stubAdapter,
  description:
    "Judge-quality battery: correct figures, but 'accelerated every month' contradicts a decelerating series. Ground truth: judge FAILS it.",
  metadata: { category: "judge-quality", ground_truth: "fail" },
  deliverables: ["report", "work_log"],
});

test("trend-claim-supported", async (t) => {
  await t.agent(TREND_RUBRIC, { label: "agentic-support", expect: "fail" });
});
