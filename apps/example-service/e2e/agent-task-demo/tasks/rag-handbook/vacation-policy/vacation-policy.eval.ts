import { task, includes } from "@apo-ai/sdk/agent-task";
import { ragAdapter } from "../../../rag-adapter.ts";

// A handbook chatbot over a document store shared by two tenants. The
// retrieval tests are deterministic facts about what the real run retrieved;
// the grounded tests ask a judge whether the answer stays inside those
// documents. Run with HANDBOOK_TENANT_FILTER=off to watch the leak test catch
// a search that forgot its tenant scope.

const { test } = task("rag-vacation-policy", {
  adapter: ragAdapter,
  description: "Answer a vacation-policy question from the employee handbook, without leaking another tenant's documents.",
  metadata: { category: "rag", difficulty: "easy", sdk: "ai-sdk" },
  maxTurns: 1,
  deliverables: ["answer"],
});

test("finds the vacation allowance", (t) => {
  t.retrieved("handbook-vacation", { topK: 3 });
});

test("finds the carry-over rule", (t) => {
  t.retrieved("handbook-carryover");
});

test("never retrieves another tenant's documents", (t) => {
  t.not.retrieved({ idPrefix: "acme-" });
});

test("searches at most three times", (t) => {
  t.maxRetrievals(3);
});

test("states the 25-day allowance", (t, { deliverables }) => {
  t.check(deliverables.answer, includes("25"));
});

test("answer is grounded in what was retrieved", async (t, { deliverables }) => {
  await t.grounded(deliverables.answer);
});

test("judge catches an invented policy", async (t) => {
  await t.grounded(
    "You get 25 days of paid vacation, and unused days can be sold back for cash at the end of the year.",
    { expect: "fail", label: "catches invented sell-back policy" },
  );
});
