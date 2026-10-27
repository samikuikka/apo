import { defineAdapter, task } from "@apo-ai/sdk/agent-task";

/**
 * t.semantic live probe — NOT a product task.
 *
 * A stub agent (no LLM) returns one fixed answer deliverable, and
 * embedding-similarity checks grade it against live embeddings via
 * OpenRouter (`openai/text-embedding-3-small` from `OPENROUTER_API_KEY`).
 * Calibrated by construction:
 *
 *   - identical reference        → cosine 1.0    → PASS at 0.9
 *   - close paraphrase reference → cosine ~0.85  → PASS at 0.7
 *   - unrelated reference        → cosine ~0.3   → FAIL at 0.6 (the check
 *     must be able to fail, and semantic similarity is not correctness)
 *
 * The answer never changes, so any score movement across runs is the
 * embedding model, not the agent — same contract as judge-flip-probe.
 */

const ANSWER =
  "The refund policy allows customers to return items within 30 days of " +
  "purchase, provided they show a receipt.";

const stubAdapter = defineAdapter({
  name: "answer-stub",
  deliverables: { answer: null },
  // One user turn, then the runner stops (null = no further turns).
  turn: (ctx) => (ctx.transcript.length === 0 ? "answer the question" : null),
  startSession: async () => ({
    sendUserTurn: async () => ({ response: "done" }),
  }),
  collectDeliverables: async () => ({ answer: ANSWER }),
});

const { test } = task("semantic-similarity-probe", {
  adapter: stubAdapter,
  description:
    "Fixed-answer probe for the t.semantic embedding-similarity check against live embeddings.",
  metadata: { category: "measurement", probe: "t-semantic" },
  deliverables: ["answer"],
});

test("identical-reference-passes", async (t, { deliverables }) => {
  await t.semantic(deliverables.answer, ANSWER, { threshold: 0.9 });
});

test("paraphrase-reference-passes", async (t, { deliverables }) => {
  await t.semantic(
    deliverables.answer,
    "Customers can return purchased items within 30 days as long as they present a receipt.",
    { threshold: 0.7 },
  );
});

test("unrelated-reference-fails", async (t, { deliverables }) => {
  // Calibrated to FAIL by construction: the fixed answer is unrelated to
  // this reference, so a healthy probe run is RED — the check's failure
  // line carries the score and threshold. Same convention as
  // judge-flip-probe's clearly-FAIL criteria.
  await t.semantic(
    deliverables.answer,
    "The quarterly earnings call highlighted strong growth in the European market.",
    { threshold: 0.6 },
  );
});
