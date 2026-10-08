import { task, includes, filePaths } from "@apo-ai/sdk/agent-task";
import { aiSdkAdapter } from "../../../ai-sdk-adapter.ts";

// The serving-integrity variant of data-extraction: identical agent work,
// plus the strict check that every generation was served by the model it
// requested. A gateway fallback (LiteLLM router, OpenRouter provider/model
// fallback) swaps the serving model mid-run — this task FAILS when that
// happens, instead of letting the verdict claim the requested model's
// capability. Run it against a stable endpoint to PASS; run it behind a
// fallback-configured gateway to see the drift caught.

const { test } = task("serving-integrity", {
  adapter: aiSdkAdapter,
  description:
    "Data extraction that must run entirely on the requested model — a gateway fallback fails the run.",
  metadata: { category: "serving-integrity", difficulty: "easy", sdk: "ai-sdk" },
  maxTurns: 2,
  deliverables: ["result", "tool_log", "stats"],
});

test("no-model-drift", (t) => {
  t.noModelDrift();
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
