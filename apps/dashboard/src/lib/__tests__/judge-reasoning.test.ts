import { describe, it, expect } from "vitest";
import { extractJudgeReasoning } from "../judge-reasoning";

describe("extractJudgeReasoning", () => {
  it("extracts reasoning from a single-object response", () => {
    expect(
      extractJudgeReasoning({ response: '{"pass": true, "reasoning": "looks good"}' }),
    ).toBe("looks good");
  });

  it("extracts reasoning from an array (per-value) response", () => {
    expect(
      extractJudgeReasoning({
        response: '[{"pass": false, "reasoning": "Value 1 fails because X"}]',
      }),
    ).toBe("Value 1 fails because X");
  });

  it("joins multiple per-value reasons", () => {
    const out = extractJudgeReasoning({
      response:
        '[{"pass": false, "reasoning": "fails A"}, {"pass": true, "reasoning": "ok B"}]',
    });
    expect(out).toContain("fails A");
    expect(out).toContain("ok B");
  });

  it("parses a JSON object embedded in surrounding prose", () => {
    expect(
      extractJudgeReasoning({ response: "Here is the verdict:\n{\"pass\": false, \"reasoning\": \"nope\"}\n" }),
    ).toBe("nope");
  });

  it("returns undefined when there is no reasoning field", () => {
    expect(extractJudgeReasoning({ response: '{"pass": true}' })).toBeUndefined();
  });

  it("returns undefined for unparseable / empty responses", () => {
    expect(extractJudgeReasoning({ response: "" })).toBeUndefined();
    expect(extractJudgeReasoning({ response: "not json at all" })).toBeUndefined();
    expect(extractJudgeReasoning({})).toBeUndefined();
  });
});
