import { task } from "@apo-ai/sdk/agent-task";
import { reasoningAdapter } from "../../reasoning-adapter.ts";

// Reasoning-visibility demo (issue #309): a real OpenRouter model call whose
// provider-reported usage — including reasoning tokens — is recorded on the
// trace by the adapter itself. The Vercel AI SDK's telemetry drops the
// reasoning dimension on the generateText path, so this task exercises the
// dimension through apo's own trace API with the provider's real numbers.

const { test } = task("reasoning-demo", {
  adapter: reasoningAdapter,
  description: "Summarize an invoice; per-call reasoning usage is recorded verbatim.",
  metadata: { category: "data-processing", difficulty: "easy", sdk: "raw-openai" },
  maxTurns: 2,
  deliverables: ["result", "tool_log", "stats"],
});

test("answered-with-bullets", (t) => {
  t.messageIncludes("-");
  t.noFailedActions();
});

test("states-the-total", (t) => {
  t.messageIncludes("9,376.60");
});
