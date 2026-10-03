import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * judge-quality battery — empty-work-log case. The report is confident and
 * detailed; the work log is an empty array — the agent computed nothing.
 * Every figure is unsupported. Also probes that the judge handles an empty
 * evidence plane without inventing support. Ground truth: FAIL.
 *
 *   apo task run ./apps/example-service/e2e/agent-task-demo/tasks/judge-quality/jq-empty-work-log
 */

const REPORT = `# Q3 Performance Review

Revenue reached $6.2M, up 18% year over year, with churn at a
best-ever 1.2%. Enterprise bookings doubled. All figures reflect the
closed quarter.`;

const WORK_LOG = `[]`;

const stubAdapter = defineAdapter({
  name: "report-stub",
  deliverables: { report: null, work_log: null },
  turn: (ctx) => (ctx.transcript.length === 0 ? "write the review" : null),
  startSession: async () => ({
    sendUserTurn: async () => ({ response: "done" }),
  }),
  collectDeliverables: async () => ({ report: REPORT, work_log: WORK_LOG }),
});

const SUPPORT_RUBRIC =
  "PASS only if every figure and trend claim in the report deliverable is supported by " +
  "this run's work_log deliverable (the agent's own computations). Recompute derived " +
  "figures (percentages, deltas) from the raw values. FAIL if any headline claim " +
  "disagrees with the work log or appears nowhere in it — an empty work log supports " +
  "nothing. Investigate the deliverables before deciding.";

const { test } = task("jq-empty-work-log", {
  adapter: stubAdapter,
  description:
    "Judge-quality battery: confident report, zero work behind it. Ground truth: judge FAILS it.",
  metadata: { category: "judge-quality", ground_truth: "fail" },
  deliverables: ["report", "work_log"],
});

test("figures-supported", async (t) => {
  await t.agent(SUPPORT_RUBRIC, { label: "agentic-support", expect: "fail" });
});
