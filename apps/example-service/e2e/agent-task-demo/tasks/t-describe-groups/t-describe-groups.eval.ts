import { defineAdapter, equals, includes, task } from "@apo-ai/sdk/agent-task";

/**
 * describe()-grouping demo — NOT a product task.
 *
 * A stub agent (no LLM) and deterministic `t.check` assertions only, so the
 * run costs nothing and lands with two describe() groups plus one bare
 * check — the exact layout the dashboard's collapsible group headers and
 * persisted open/closed state are built against.
 *
 *   apo task run ./apps/example-service/e2e/agent-task-demo/tasks/t-describe-groups
 */

const SUMMARY = `# Q3 Revenue Summary

Revenue grew 3.0% quarter over quarter. Enterprise share of revenue was 61%.
All numbers come from the billing extract.`;

const stubAdapter = defineAdapter({
  name: "groups-stub",
  deliverables: { summary: null },
  turn: (ctx) => (ctx.transcript.length === 0 ? "write the summary" : null),
  startSession: async () => ({
    sendUserTurn: async () => ({ response: "done" }),
  }),
  collectDeliverables: async () => ({ summary: SUMMARY }),
});

const { test, describe } = task("t-describe-groups", {
  adapter: stubAdapter,
  description:
    "Fixed-deliverable demo of describe() groups in the dashboard checks panel.",
  metadata: { category: "demo", probe: "describe-groups" },
  deliverables: ["summary"],
});

describe("headline-figures", "Headline figures the summary must state", () => {
  test("growth-stated", (t, { deliverables }) => {
    t.check(
      deliverables.summary,
      includes("grew 3.0%"),
      "summary states the 3.0% growth figure",
    );
  });

  test("enterprise-share-stated", (t, { deliverables }) => {
    t.check(
      deliverables.summary,
      includes("61%"),
      "summary states the 61% enterprise share",
    );
  });

  // Deliberate fail: gives the group a red roll-up, like a real suite.
  test("churn-stated", (t, { deliverables }) => {
    t.check(
      deliverables.summary,
      includes("churn"),
      "summary states the churn direction",
    );
  });
});

describe("formatting", "Formatting rules for the summary", () => {
  test("markdown-heading", (t, { deliverables }) => {
    t.check(
      String(deliverables.summary).startsWith("# Q3 Revenue Summary"),
      equals(true),
      "summary opens with the Q3 heading",
    );
  });

  test("mentions-source", (t, { deliverables }) => {
    t.check(
      deliverables.summary,
      includes("billing extract"),
      "summary names its data source",
    );
  });
});

// A bare check outside any group renders at the top level.
test("summary-nonempty", (t, { deliverables }) => {
  t.check(
    String(deliverables.summary).trim().length > 0,
    equals(true),
    "summary is not empty",
  );
});
