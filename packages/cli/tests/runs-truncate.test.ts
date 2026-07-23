import { describe, expect, it } from "vitest";
import {
  DELIVERABLE_PREVIEW_CHARS,
  RECEIVED_PREVIEW_CHARS,
  conciseChecks,
  conciseDeliverables,
  previewString,
  truncateValue,
} from "../src/lib/runs-truncate.ts";
import type { CheckResult } from "../src/lib/agent-task-types.ts";

describe("previewString", () => {
  it("returns short strings unchanged", () => {
    expect(previewString("ok", 500)).toBe("ok");
  });

  it("truncates long strings with a total-length hint", () => {
    const big = "x".repeat(2000);
    const out = previewString(big, 500);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("2,000 chars");
    expect(out).toContain("--full");
    // No content body is included — manifest only.
    expect(out).not.toContain("x".repeat(600));
  });
});

describe("truncateValue", () => {
  it("passes null/undefined through", () => {
    expect(truncateValue(null, 500, false)).toBeNull();
    expect(truncateValue(undefined, 500, false)).toBeUndefined();
  });

  it("leaves small strings and small objects unchanged (type preserved)", () => {
    expect(truncateValue("small", 500, false)).toBe("small");
    const obj = { a: 1, b: "two" };
    expect(truncateValue(obj, 500, false)).toBe(obj);
  });

  it("previews a huge string", () => {
    const big = "Y".repeat(5000);
    const out = truncateValue(big, 500, false) as string;
    expect(typeof out).toBe("string");
    expect(out).toContain("5,000 chars");
    expect(out).toContain("--full");
    expect(out.length).toBeLessThan(big.length);
  });

  it("previews a huge object as a manifest string (kills structured bloat too)", () => {
    const huge = { memo: "Z".repeat(5000) };
    const out = truncateValue(huge, 500, false) as string;
    expect(typeof out).toBe("string");
    expect(out).toContain("chars");
    expect(out).toContain("--full");
  });

  it("returns the original value verbatim when full=true", () => {
    const big = "Q".repeat(5000);
    expect(truncateValue(big, 500, true)).toBe(big);
    const hugeObj = { memo: "Q".repeat(5000) };
    expect(truncateValue(hugeObj, 500, true)).toBe(hugeObj);
  });
});

describe("conciseChecks", () => {
  const hugeMemo = "M".repeat(20_000);

  it("truncates huge assertion received + judge prompt/response, keeps reasoning", () => {
    const checks: CheckResult[] = [
      {
        id: "non-compete",
        pass: false,
        reasoning: "memo omits non-compete analysis",
        assertions: [
          {
            id: "judge(non-compete)",
            pass: false,
            reasoning: "The memorandum does not analyze non-compete enforceability.",
            expected: "PASS when non-compete is analyzed",
            received: hugeMemo,
            judge: {
              model: "anthropic/claude-haiku-4.5",
              prompt: { system: "SYS\n" + hugeMemo, user: "Instruction" },
              response: '{"pass":false,"reasoning":"' + "R".repeat(4000) + '"}',
            },
          },
        ],
      },
    ];

    const out = conciseChecks(checks, false);
    const a = out[0]!.assertions![0]!;
    // Reasoning/expected/id are the useful, small fields — never touched.
    expect(a.reasoning).toBe("The memorandum does not analyze non-compete enforceability.");
    expect(a.expected).toBe("PASS when non-compete is analyzed");
    expect(a.id).toBe("judge(non-compete)");
    // The huge deliverable is omitted (manifest only), not dumped in full.
    expect(a.received).not.toContain("M".repeat(10));
    expect(a.received).toContain("--full");
    expect(a.judge!.prompt!.system).toContain("--full");
    expect(a.judge!.response).toContain("--full");
  });

  it("leaves small received values as their original type", () => {
    const checks: CheckResult[] = [
      {
        id: "c",
        pass: false,
        reasoning: "x",
        assertions: [{ id: "a", pass: false, reasoning: "r", expected: "1", received: "0" }],
      },
    ];
    const out = conciseChecks(checks, false);
    expect(out[0]!.assertions![0]!.received).toBe("0");
  });

  it("returns everything verbatim when full=true", () => {
    const checks: CheckResult[] = [
      {
        id: "c",
        pass: false,
        reasoning: "x",
        assertions: [{ id: "a", pass: false, reasoning: "r", received: hugeMemo }],
      },
    ];
    const out = conciseChecks(checks, true);
    expect(out[0]!.assertions![0]!.received).toBe(hugeMemo);
  });

  it("does not mutate the input checks", () => {
    const checks: CheckResult[] = [
      {
        id: "c",
        pass: false,
        reasoning: "x",
        assertions: [{ id: "a", pass: false, reasoning: "r", received: hugeMemo }],
      },
    ];
    conciseChecks(checks, false);
    expect(checks[0]!.assertions![0]!.received).toBe(hugeMemo);
  });
});

describe("conciseDeliverables", () => {
  it("previews huge deliverable values, keeps small ones", () => {
    const big = "D".repeat(10_000);
    const d = conciseDeliverables({ memo: big, count: 3 }, false);
    expect(d.count).toBe(3);
    const memo = d.memo as string;
    expect(memo).toContain("--full");
    expect(memo).toContain("10,000 chars");
    expect(memo.length).toBeLessThan(big.length);
  });

  it("uses a small manifest threshold", () => {
    expect(RECEIVED_PREVIEW_CHARS).toBeLessThanOrEqual(1000);
    expect(DELIVERABLE_PREVIEW_CHARS).toBeLessThanOrEqual(1000);
  });

  it("returns the original deliverables when full=true", () => {
    const big = "D".repeat(10_000);
    const d = conciseDeliverables({ memo: big }, true);
    expect(d.memo).toBe(big);
  });

  it("passes null through", () => {
    expect(conciseDeliverables(null, false)).toBeNull();
  });
});
