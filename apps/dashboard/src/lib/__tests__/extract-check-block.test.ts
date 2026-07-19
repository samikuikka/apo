import { describe, expect, it } from "vitest";
import { extractCheckBlock } from "../extract-check-block";

const source = `import { test } from "@apo/sdk/agent-task";

test("quality", async (t, { deliverables }) => {
  t.calledTool("read_file");
  await t.judge(
    deliverables.result,
    "PASS when the answer is grounded",
  );
});
`;

describe("extractCheckBlock", () => {
  it("extracts an LLM-backed test as a normal code check", () => {
    expect(extractCheckBlock(source, { id: "quality" })).toEqual({
      code: `test("quality", async (t, { deliverables }) => {
  t.calledTool("read_file");
  await t.judge(
    deliverables.result,
    "PASS when the answer is grounded",
  );
});`,
      startLine: 3,
      endLine: 9,
    });
  });

  it("anchors the block from a failed judge assertion line", () => {
    expect(extractCheckBlock(source, { anchorLine: 5 })?.startLine).toBe(3);
  });

  it("extracts a check registered via a typed alias (const check = test<T>)", () => {
    const aliasedSource = `import { test } from "@apo/sdk/agent-task";

const check = test<RealAgentDeliverables>;

check("reviewed-methodically", async (t, { deliverables }) => {
  t.calledTool("read_file");
  await t.judge(deliverables.result, "PASS when steps are listed");
});

check("used-read-and-search-tools", async (t) => {
  t.calledTool("read_file");
});
`;
    const block = extractCheckBlock(aliasedSource, { id: "reviewed-methodically" });
    expect(block).toEqual({
      code: `check("reviewed-methodically", async (t, { deliverables }) => {
  t.calledTool("read_file");
  await t.judge(deliverables.result, "PASS when steps are listed");
});`,
      startLine: 5,
      endLine: 8,
    });

    // The second alias-registered check resolves too.
    expect(extractCheckBlock(aliasedSource, { id: "used-read-and-search-tools" })?.startLine).toBe(10);
  });

  it("anchors from a failure line within an aliased check", () => {
    const aliasedSource = `const check = test<T>;
check("quality", async (t) => {
  t.calledTool("read_file");
});
`;
    expect(extractCheckBlock(aliasedSource, { anchorLine: 3 })?.startLine).toBe(2);
  });
});
