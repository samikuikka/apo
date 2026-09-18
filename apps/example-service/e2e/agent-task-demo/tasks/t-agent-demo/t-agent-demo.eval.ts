import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * t.agent demo — the miniature of the real finding that motivated the
 * agentic judge: an agent whose summary reads plausibly but contradicts its
 * own work log. The single-shot judge sees only the summary (values are
 * pre-extracted by the author); the agentic judge investigates both
 * deliverables and catches the unsupported figures.
 *
 *   apo task run ./apps/example-service/e2e/agent-task-demo/tasks/t-agent-demo
 *
 * Judge model comes from the environment (OPENROUTER_MODEL etc.); use a
 * tool-calling-capable model — e.g. deepseek/deepseek-v4.1-flash.
 */

const SUMMARY = `# Q3 Revenue Summary

Revenue grew 12% to $4.2M in Q3. Churn improved to 2.1% (down from 2.4% in
Q2), and enterprise ARR now covers 68% of the total. The numbers below are
taken directly from our billing extract.`;

const WORK_LOG = `[{"tool":"run_sql","code":"SELECT SUM(amount) FROM invoices WHERE quarter='2026-Q3'","result":{"revenue":4003112}},{"tool":"run_sql","code":"SELECT SUM(amount) FROM invoices WHERE quarter='2026-Q2'","result":{"revenue":3885017}},{"tool":"run_sql","code":"churned_mrr / total_mrr at quarter end","result":{"q2_churn":0.024,"q3_churn":0.029}},{"tool":"run_sql","code":"enterprise_arr / total_arr","result":{"enterprise_share":0.61}}]`;

// The demo replays the work_log's queries as REAL tool spans, so the run's
// trace looks exactly like a genuine analysis run — same information as
// real runs, just deterministic and read-only. The judge's get_trace then
// returns actual tool-call evidence instead of an honest "unavailable".
const WORK = JSON.parse(WORK_LOG) as {
  tool: string;
  code: string;
  result: unknown;
}[];

const stubAdapter = defineAdapter({
  name: "report-stub",
  deliverables: { summary: null, work_log: null },
  turn: (ctx) => (ctx.transcript.length === 0 ? "write the Q3 summary" : null),
  startSession: async () => ({
    sendUserTurn: async (_turn, { trace }) => {
      for (const call of WORK) {
        await trace.traceTool(call.tool, { code: call.code }, async () => call.result);
      }
      return { response: "done" };
    },
  }),
  collectDeliverables: async () => ({ summary: SUMMARY, work_log: WORK_LOG }),
});

const { test } = task("t-agent-demo", {
  adapter: stubAdapter,
  description:
    "Agentic-judge demo: the summary claims figures its own work log does not support.",
  metadata: { category: "demo", probe: "t-agent" },
  deliverables: ["summary", "work_log"],
});

// Baseline: the single-shot judge grades the pre-extracted value only. It
// has no access to the work, so plausible-but-unsupported figures pass.
test("summary-reads-well", async (t, { deliverables }) => {
  await t.judge(
    deliverables.summary,
    "PASS if the summary reads like a coherent, well-formed revenue report with concrete figures. " +
      "FAIL only if it is incoherent, vague, or missing numbers.",
  );
});

// The agentic judge: same rubric family, but it must verify the figures
// against the run's own work — the thing a value-only judge cannot do.
test("figures-supported-by-work", async (t) => {
  await t.agent(
    "PASS only if every figure in the summary deliverable is supported by this run's " +
      "work_log deliverable (the agent's own computations). FAIL if any headline figure " +
      "(revenue, growth, churn, enterprise share) disagrees with the work log or appears " +
      "nowhere in it. Investigate the deliverables before deciding.",
    { label: "agentic-consistency" },
  );
});
