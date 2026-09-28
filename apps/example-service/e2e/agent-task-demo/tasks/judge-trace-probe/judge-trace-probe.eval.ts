import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * Issue #288 verification probe — NOT a product task.
 *
 * A stub agent (no LLM) returns one fixed finding, and two judged checks
 * grade it: one single-shot `t.judge`, one agentic `t.agent` that must read
 * the deliverable before verdicting. The run is traced, so both judges'
 * spans land in the trace view and each check's judge metadata carries its
 * span id (`traceObservationId`) — the check → judge-trace deep link.
 */

const FINDING = `# Q3 Revenue Finding

Revenue grew 3.0% quarter over quarter. Enterprise share of revenue was 61%.
Churn worsened by 0.8 points. All numbers come from the billing extract
attached to this task's files.`;

const stubAdapter = defineAdapter({
  name: "md-stub",
  deliverables: { finding: null },
  turn: (ctx) => (ctx.transcript.length === 0 ? "write the finding" : null),
  startSession: async () => ({
    sendUserTurn: async () => ({ response: "done" }),
  }),
  collectDeliverables: async () => ({ finding: FINDING }),
});

const { test } = task("judge-trace-probe", {
  adapter: stubAdapter,
  description:
    "Fixed-deliverable probe verifying judge spans and the check→trace deep link (#288).",
  metadata: { category: "measurement", probe: "issue-288" },
  deliverables: ["finding"],
});

test("growth-claim", async (t, { deliverables }) => {
  await t.judge(deliverables.finding, "The finding states revenue grew 3.0%.");
});

test("grounded-claims", async (t) => {
  await t.agent(
    "Read the finding and verify every number it states appears there. PASS only if the growth percentage, enterprise share, and churn direction all match the finding's own text.",
    { label: "agent-grounding" },
  );
});
