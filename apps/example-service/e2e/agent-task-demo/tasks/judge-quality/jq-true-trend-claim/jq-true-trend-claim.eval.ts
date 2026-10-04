import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * judge-quality battery — true-trend-claim case. The mirror of
 * jq-false-trend-claim: growth genuinely accelerates every month
 * (+4.4%, +6.3%, +9.0%), and the report says exactly that. Guards
 * against over-strict judges that fail trend language on principle
 * after learning to distrust it. Ground truth: PASS.
 *
 *   apo task run ./apps/example-service/e2e/agent-task-demo/tasks/judge-quality/jq-true-trend-claim
 */

const REPORT = `# Signup Momentum Note

Signup growth accelerated every month this quarter: July +4.4%,
August +6.3%, September +9.0%. The trend is genuinely strengthening and
September is our strongest momentum month of the three.`;

const WORK_LOG = `[{"tool":"run_sql","code":"monthly active signups, Jun-Sep","result":{"months":[{"month":"2026-06","signups":1000},{"month":"2026-07","signups":1044},{"month":"2026-08","signups":1110},{"month":"2026-09","signups":1210}]}}]`;

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

const { test } = task("jq-true-trend-claim", {
  adapter: stubAdapter,
  description:
    "Judge-quality battery: growth genuinely accelerates (+4.4%, +6.3%, +9.0%) and the report says so. Ground truth: judge PASSES it.",
  metadata: { category: "judge-quality", ground_truth: "pass" },
  deliverables: ["report", "work_log"],
});

test("trend-claim-supported", async (t) => {
  await t.agent(TREND_RUBRIC, { label: "agentic-support" });
});
