import { task } from "@apo-ai/sdk/agent-task";
import { aiSdkAdapter } from "../../../ai-sdk-adapter.ts";

// Judge served-model proof task: a single-shot t.judge whose gateway serves
// the verdict with a DIFFERENT model than requested (mock-gateway's judge
// fallback). The judge metadata must record judge.served_model, and the
// judge span carries gen_ai.response.model so the backend prices and
// attributes the judging spend to the model that actually judged.

const { test } = task("judge-served-model", {
  adapter: aiSdkAdapter,
  description:
    "One judged check — the judge's serving gateway falls back to a different model.",
  metadata: { category: "serving-integrity", difficulty: "easy", sdk: "ai-sdk" },
  maxTurns: 2,
  deliverables: ["result", "tool_log", "stats"],
});

test("summary-quality", async (t) => {
  await t.judge(
    "The invoice summary with all fields extracted.",
    "PASS when the summary lists invoice id, total, due date, and contact.",
  );
});
