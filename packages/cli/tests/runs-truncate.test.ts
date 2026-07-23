import { describe, expect, it } from "vitest";
import {
  DELIVERABLE_PREVIEW_CHARS,
  RECEIVED_PREVIEW_CHARS,
  conciseChecks,
  conciseDeliverables,
  manifestFor,
  previewString,
  truncateValue,
} from "../src/lib/runs-truncate.ts";
import type { CheckResult } from "../src/lib/agent-task-types.ts";

describe("manifestFor", () => {
  it("names the total length and points at `apo runs deliverable`", () => {
    expect(manifestFor(20_000)).toBe("⟨20,000 chars — apo runs deliverable⟩");
  });
});

describe("previewString", () => {
  it("returns short strings unchanged", () => {
    expect(previewString("ok", 500)).toBe("ok");
  });

  it("replaces long strings with a manifest (no content body)", () => {
    const big = "x".repeat(2000);
    const out = previewString(big, 500);
    expect(out).toBe("⟨2,000 chars — apo runs deliverable⟩");
    expect(out).not.toContain("x");
  });
});

describe("truncateValue", () => {
  it("passes null/undefined through", () => {
    expect(truncateValue(null, 500)).toBeNull();
    expect(truncateValue(undefined, 500)).toBeUndefined();
  });

  it("leaves small strings and small objects unchanged (type preserved)", () => {
    expect(truncateValue("small", 500)).toBe("small");
    const obj = { a: 1, b: "two" };
    expect(truncateValue(obj, 500)).toBe(obj);
  });

  it("replaces a huge string with the manifest", () => {
    const big = "Y".repeat(5000);
    expect(truncateValue(big, 500)).toBe("⟨5,000 chars — apo runs deliverable⟩");
  });

  it("replaces a huge object with the manifest (kills structured bloat too)", () => {
    const huge = { memo: "Z".repeat(5000) };
    expect(truncateValue(huge, 500)).toMatch(/⟨[\d,]+ chars — apo runs deliverable⟩/);
  });
});

describe("conciseChecks", () => {
  const hugeMemo = "M".repeat(20_000);

  it("manifests huge assertion received + judge prompt/response, keeps the useful small fields", () => {
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

    const out = conciseChecks(checks)!;
    const a = out[0]!.assertions![0]!;
    // Reasoning/expected/id are the useful, small fields — never touched.
    expect(a.reasoning).toBe("The memorandum does not analyze non-compete enforceability.");
    expect(a.expected).toBe("PASS when non-compete is analyzed");
    expect(a.id).toBe("judge(non-compete)");
    // The huge deliverable is a manifest pointing at `apo runs deliverable`.
    expect(a.received).toBe("⟨20,000 chars — apo runs deliverable⟩");
    expect(a.judge!.prompt!.system).toMatch(/⟨2\d,00[04] chars — apo runs deliverable⟩/);
    expect(a.judge!.response).toMatch(/⟨[\d,]+ chars — apo runs deliverable⟩/);
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
    expect(conciseChecks(checks)![0]!.assertions![0]!.received).toBe("0");
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
    conciseChecks(checks);
    expect(checks[0]!.assertions![0]!.received).toBe(hugeMemo);
  });

  it("passes null through", () => {
    expect(conciseChecks(null)).toBeNull();
  });
});

describe("conciseDeliverables", () => {
  it("manifests huge deliverable values, keeps small ones", () => {
    const big = "D".repeat(10_000);
    const d = conciseDeliverables({ memo: big, count: 3 })!;
    expect(d.count).toBe(3);
    expect(d.memo).toBe("⟨10,000 chars — apo runs deliverable⟩");
  });

  it("uses a small manifest threshold", () => {
    expect(RECEIVED_PREVIEW_CHARS).toBeLessThanOrEqual(1000);
    expect(DELIVERABLE_PREVIEW_CHARS).toBeLessThanOrEqual(1000);
  });

  it("passes null through", () => {
    expect(conciseDeliverables(null)).toBeNull();
  });
});
