import { task, includes, filePaths } from "@apo-ai/sdk/agent-task";
import { recordedAiSdkAdapter } from "../../../recorded-ai-sdk-adapter.ts";

// Keyless twin of `data-extraction`: identical tests and files, but the
// adapter replays `recorded-session.json` (a frozen session of the real
// agent) instead of calling the model. The tests are not mocked; they
// evaluate the replayed trace and recorded deliverables exactly as they
// evaluate a live run, so this PASS is a real verdict that needs no
// OPENROUTER_API_KEY, no backend, and no account:
//
//   apo task run data-extraction-replay --dir . --no-record
//
// To regenerate the recording (one live run, needs OPENROUTER_API_KEY):
//
//   APO_RECORD_FIXTURE=<this dir>/recorded-session.json \
//     apo task run data-extraction-replay --dir .
//
// After the keyless PASS, the natural next step is the live twin:
//
//   apo task run data-extraction --dir .

const { test } = task("data-extraction-replay", {
  adapter: recordedAiSdkAdapter,
  description: "Replay of a recorded data-extraction session: same tests as the live task, no API key needed.",
  metadata: { category: "data-processing", difficulty: "easy", sdk: "ai-sdk", mode: "recorded-replay" },
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
