/**
 * Showcase test: the keyless replay task as a permanent CI witness for the
 * per-key tool call checks.
 *
 * `maxToolCallsPer` and `everyToolCall` evaluate the replayed trace exactly
 * as they would a live one (the recorded adapter re-emits real spans), so
 * this passing means the two checks are wired through the whole pipeline:
 * eval file → runTaskDir → recorded adapter → trace projection → check
 * evaluation → summary. No model, no API key, no backend.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { runTaskDir } from "@apo-ai/sdk/agent-task";

const TASK_DIR = join(
  import.meta.dirname,
  "tasks/ai-sdk-agent/data-extraction-replay",
);

describe("data-extraction-replay: per-key checks against a recorded trace", () => {
  it("passes with maxToolCallsPer and everyToolCall evaluating the replay", async () => {
    const summary = await runTaskDir(TASK_DIR);

    expect(summary.taskId).toBe("data-extraction-replay");
    expect(summary.pass).toBe(true);
    expect(summary.checks).toContainEqual(
      expect.objectContaining({
        id: "per-file-and-values",
        pass: true,
      }),
    );
  });
});
