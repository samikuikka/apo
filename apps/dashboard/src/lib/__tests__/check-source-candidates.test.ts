import { describe, expect, it } from "vitest";
import {
  buildSourceCandidates,
  shouldAcceptSource,
} from "../check-source-candidates";

describe("buildSourceCandidates", () => {
  it("never produces the broken `${taskId}.eval.ts` for a folder-scoped id", () => {
    // taskId "chat/cost-inquiry" points at a folder; the eval lives one level
    // deeper as `cost-inquiry.eval.ts`. `${taskId}.eval.ts` would resolve to
    // `<task_dir>/chat/cost-inquiry.eval.ts` and 404.
    const candidates = buildSourceCandidates(undefined, "chat/cost-inquiry");
    expect(candidates).not.toContain("chat/cost-inquiry.eval.ts");
    expect(candidates[0]).toBe("cost-inquiry.eval.ts");
  });

  it("derives the eval name from the task id's last path segment", () => {
    expect(buildSourceCandidates(undefined, "chat/cost-inquiry")).toEqual([
      "cost-inquiry.eval.ts",
      "task.ts",
      "checks.ts",
    ]);
  });

  it("handles deeply nested folder-scoped ids", () => {
    expect(buildSourceCandidates(undefined, "a/b/c/deep-task")).toEqual([
      "deep-task.eval.ts",
      "task.ts",
      "checks.ts",
    ]);
  });

  it("preserves the legacy flat-id layout (no regression)", () => {
    expect(buildSourceCandidates(undefined, "code-review")).toEqual([
      "code-review.eval.ts",
      "task.ts",
      "checks.ts",
    ]);
  });

  it("puts the recorded source_file first and follows with the derived eval", () => {
    expect(buildSourceCandidates("custom.eval.ts", "code-review")).toEqual([
      "custom.eval.ts",
      "code-review.eval.ts",
    ]);
  });

  it("dedupes when the recorded source equals the derived eval candidate", () => {
    // The reported case: recorded "cost-inquiry.eval.ts" for task "chat/cost-inquiry".
    expect(buildSourceCandidates("cost-inquiry.eval.ts", "chat/cost-inquiry")).toEqual([
      "cost-inquiry.eval.ts",
    ]);
  });
});

describe("shouldAcceptSource", () => {
  it("trusts a loaded recorded source_file even when its check block can't be pinpointed", () => {
    // Helper/factory-registered checks have no literal `test("id")` opener, so
    // extractCheckBlock returns null. The recorded file is still correct and
    // should be shown rather than discarded for a 404'ing fallback.
    expect(
      shouldAcceptSource({
        candidate: "cost-inquiry.eval.ts",
        recordedSourceFile: "cost-inquiry.eval.ts",
        containsKnownCheck: false,
        isLastCandidate: false,
      }),
    ).toBe(true);
  });

  it("accepts any candidate that contains a recognizable check block", () => {
    expect(
      shouldAcceptSource({
        candidate: "anything.ts",
        recordedSourceFile: undefined,
        containsKnownCheck: true,
        isLastCandidate: false,
      }),
    ).toBe(true);
  });

  it("rejects a non-recorded fallback with no recognizable check (keep trying)", () => {
    expect(
      shouldAcceptSource({
        candidate: "task.ts",
        recordedSourceFile: undefined,
        containsKnownCheck: false,
        isLastCandidate: false,
      }),
    ).toBe(false);
  });

  it("accepts the last candidate as a last resort even without a recognizable check", () => {
    expect(
      shouldAcceptSource({
        candidate: "checks.ts",
        recordedSourceFile: undefined,
        containsKnownCheck: false,
        isLastCandidate: true,
      }),
    ).toBe(true);
  });

  it("does not treat a non-recorded fallback as trusted just because it loaded", () => {
    expect(
      shouldAcceptSource({
        candidate: "code-review.eval.ts",
        recordedSourceFile: "cost-inquiry.eval.ts",
        containsKnownCheck: false,
        isLastCandidate: false,
      }),
    ).toBe(false);
  });
});
