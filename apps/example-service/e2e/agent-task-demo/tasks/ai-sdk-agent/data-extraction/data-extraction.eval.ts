import { task, test, includes, filePaths } from "@apo/sdk/agent-task";
import { aiSdkAdapter } from "../../../ai-sdk-adapter.ts";

// Runs against the AI SDK adapter (Vercel AI SDK + registerApoTracing, pointed
// at OpenRouter/Gemini). The trace assertions are SDK-agnostic — t.calledTool
// reads from the projection regardless of which provider produced the spans.

task("data-extraction", {
  adapter: aiSdkAdapter,
  description: "Extract structured data from an invoice via the Vercel AI SDK.",
  metadata: { category: "data-processing", difficulty: "easy", sdk: "ai-sdk" },
  maxTurns: 2,
  deliverables: ["result", "tool_log", "stats"],
});

test("called-list-files", (t) => {
  t.calledTool("list_files");
  t.noFailedActions();
});

test("called-read-file", (t) => {
  t.calledTool("read_file", { input: { path: "invoice.txt" } });
});

test("called-extract-entities", (t) => {
  t.calledTool("extract_entities");
});

test("invoice-file-present", (t, { files }) => {
  const paths = filePaths(files);
  t.check(paths, includes("invoice.txt"));
});
