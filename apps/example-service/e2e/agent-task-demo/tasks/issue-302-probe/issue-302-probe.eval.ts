import { defineAdapter, equals, task } from "@apo-ai/sdk/agent-task";

/**
 * Issue #302 verification probe — NOT a product task.
 *
 * A stub agent (no LLM) returns one fixed finding, and judged checks grade
 * it: a single-shot `t.judge`, an agentic `t.agent`, and a sync check, so
 * the run's trace carries a checks.run CHAIN span with mixed evaluation
 * children nested under it — the collapsed Evaluation row's source data.
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

const { test } = task("issue-302-probe", {
  adapter: stubAdapter,
  description:
    "Fixed-deliverable probe verifying the checks.run phase span and evaluation grouping (#302).",
  metadata: { category: "measurement", probe: "issue-302" },
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

test("has-heading", (t, { deliverables }) => {
  t.check(
    String(deliverables.finding).startsWith("# Q3 Revenue Finding"),
    equals(true),
    "finding starts with the Q3 heading",
  );
});
