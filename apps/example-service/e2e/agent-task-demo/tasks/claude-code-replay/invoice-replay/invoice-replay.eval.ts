import { task, includes } from "@apo-ai/sdk/agent-task";
import { claudeCodeReplayAdapter } from "../../../claude-code-replay-adapter.ts";

// The replay-capture counterpart of the claude-agent tasks: the harness runs
// with ZERO OTel integration (no OTLP env, no TRACEPARENT) and persists its
// session JSONL; the runner replays that transcript into the run's trace.
// These assertions read the replayed projection exactly like native-OTel
// ones — that equivalence is the point of the task. Requires Anthropic
// budget (CLAUDE_MODEL + ANTHROPIC_API_KEY); run the same-shaped task under
// the claude-agent adapter to compare the two capture paths side by side.

const { test } = task("invoice-replay", {
  adapter: claudeCodeReplayAdapter,
  description: "Read an invoice and report its total via replay-captured Claude Code.",
  metadata: { category: "data-processing", difficulty: "easy", sdk: "claude-code-replay" },
  maxTurns: 2,
  deliverables: ["result", "stats"],
});

test("called-read", (t) => {
  t.calledTool("Read");
  t.noFailedActions();
});

test("reports-the-total", (t, { deliverables }) => {
  const result = deliverables.result as { summary: string };
  t.check(result.summary, includes("100"));
});
