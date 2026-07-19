import { describe, it, expect } from "vitest";
import { locateAssertionInBlock, locateAssertionsInBlock } from "../locate-assertion";

// A realistic check block — line numbers are asserted below, keep stable.
// Line 8 is a comment: the whole point is that markers must NOT land there.
const block = `check("reviewed-methodically", (t) => {
  // Read BOTH files (not just one), in a sensible order, then search.
  t.calledTool("list_files");
  t.calledTool("read_file", { input: { path: /source\\.py/ } });
  t.calledTool("read_file", { input: { path: /tests\\.py/ } });
  t.toolOrder(["read_file", "search_content"]);
  t.calledTool("search_content");
  // Anti-flail: no destructive actions, bounded effort, no errors.
  t.notCalledTool(/^(write_file|delete_file|edit)$/);
  t.maxToolCalls(MAX_TOOL_CALLS);
  t.maxTurns(MAX_TURNS);
  t.maxDurationMs(MAX_DURATION_MS);
  t.noFailedActions();
});`;

describe("locateAssertionInBlock", () => {
  it("finds a quoted-arg calledTool on the right line (never a nearby comment)", () => {
    expect(locateAssertionInBlock(block, 'calledTool("search_content")')).toBe(7);
    expect(locateAssertionInBlock(block, 'calledTool("list_files")')).toBe(3);
  });

  it("matches by method name when the arg is a literal-vs-constant mismatch (40 vs MAX_TOOL_CALLS)", () => {
    expect(locateAssertionInBlock(block, "maxToolCalls(40)")).toBe(10);
    expect(locateAssertionInBlock(block, "maxTurns(10)")).toBe(11);
    expect(locateAssertionInBlock(block, "maxDurationMs(300000)")).toBe(12);
  });

  it("finds a regex-arg notCalledTool", () => {
    expect(locateAssertionInBlock(block, "notCalledTool(/^(write_file|delete_file|edit)$/)")).toBe(9);
  });

  it("finds an array-arg toolOrder", () => {
    expect(locateAssertionInBlock(block, "toolOrder(read_file → search_content)")).toBe(6);
  });

  it("finds a no-arg assertion by method name", () => {
    expect(locateAssertionInBlock(block, "noFailedActions")).toBe(13);
  });

  it("finds an awaited judge call on its OPENING line, not the closing brace", () => {
    const judgeBlock = `check("q", async (t) => {
  await t.judge(
    deliverables.result,
    "PASS when grounded",
  );
});`;
    expect(locateAssertionInBlock(judgeBlock, "judge")).toBe(2);
  });

  it("returns undefined for a custom assert label (no method to match)", () => {
    expect(locateAssertionInBlock(block, "used file-exploration tools")).toBeUndefined();
  });

  it("returns undefined when the assertion is not present in the block", () => {
    expect(locateAssertionInBlock(block, 'calledTool("nonexistent")')).toBeUndefined();
  });
});

describe("locateAssertionsInBlock", () => {
  it("places multiple same-method assertions at distinct lines in occurrence order", () => {
    const multiJudgeBlock = `check("quality", async (t, { deliverables }) => {
  const { result } = deliverables;
  await t.judge(
    result.findings,
    "PASS if specific",
  );
  await t.judge(
    result.summary,
    "PASS if concise",
  );
});`;

    const assertions = [
      { id: "judge", location: { line: 3 } },
      { id: "judge", location: { line: 7 } },
    ];

    const lines = locateAssertionsInBlock(multiJudgeBlock, assertions);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(3);
    expect(lines[1]).toBe(7);
    expect(lines[0]).not.toBe(lines[1]);
  });

  it("falls back to stored location when method count in code is less than assertions", () => {
    const block2 = `check("x", async (t) => {
  await t.judge(v, "one");
});`;
    const assertions = [
      { id: "judge", location: { line: 2 } },
      { id: "judge", location: { line: 99 } },
    ];
    const lines = locateAssertionsInBlock(block2, assertions);
    expect(lines[0]).toBe(2);
    expect(lines[1]).toBeUndefined();
  });
});
