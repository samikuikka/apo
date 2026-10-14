import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateComputeExpression,
  COMPUTE_MAX_EXPR,
  COMPUTE_MAX_DEPTH,
} from "../src/agent-task/checks/compute.ts";

/**
 * The judge's compute tool — the evaluator in isolation. Grammar, precedence,
 * caps, honest errors, and the "not code execution" property pinned on the
 * module's own source. The session-level behavior (budget, manifest, dedupe)
 * lives in agent-judge.test.ts.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPUTE_SOURCE = readFileSync(
  join(__dirname, "../src/agent-task/checks/compute.ts"),
  "utf8",
);

const ok = (expression: string): { value: number; text: string } => {
  const result = evaluateComputeExpression(expression);
  if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
  return result;
};

const err = (expression: string): string => {
  const result = evaluateComputeExpression(expression);
  if (!("error" in result)) throw new Error(`expected an error, got ${JSON.stringify(result)}`);
  return result.error;
};

describe("compute evaluator — grammar", () => {
  it("applies operator precedence and associativity", () => {
    expect(ok("2+3*4").value).toBe(14);
    expect(ok("1-2-3").value).toBe(-4);
    expect(ok("100/10/5").value).toBe(2);
    expect(ok("2^3^2").value).toBe(512);
    expect(ok("10-2+3").value).toBe(11);
    expect(ok("7%4").value).toBe(3);
  });

  it("binds unary minus looser than ^ but allows it in exponents", () => {
    expect(ok("-3^2").value).toBe(-9);
    expect(ok("2^-3").value).toBe(0.125);
    expect(ok("--5").value).toBe(5);
    expect(ok("2 - -3").value).toBe(5);
    expect(ok("+5").value).toBe(5);
  });

  it("skips whitespace anywhere between tokens", () => {
    expect(ok("  1 +\t2 * 3 ").value).toBe(7);
  });

  it("parses scientific notation", () => {
    expect(ok(".5e1").value).toBe(5);
    expect(ok("1.5e-2").value).toBe(0.015);
    expect(ok("2E3").value).toBe(2000);
  });

  it("evaluates the allowlisted functions and constants", () => {
    expect(ok("abs(-2.5)").value).toBe(2.5);
    expect(ok("ceil(1.2)").value).toBe(2);
    expect(ok("floor(-1.2)").value).toBe(-2);
    expect(ok("round(3.7)").value).toBe(4);
    expect(ok("round(3.4013605442176873, 2)").value).toBe(3.4);
    expect(ok("sqrt(16)").value).toBe(4);
    expect(ok("cbrt(27)").value).toBe(3);
    expect(ok("pow(2,10)").value).toBe(1024);
    expect(ok("min(2,-1,0.5)").value).toBe(-1);
    expect(ok("max(2,-1,0.5)").value).toBe(2);
    expect(ok("ln(e)").value).toBeCloseTo(1, 12);
    expect(ok("log10(1000)").value).toBeCloseTo(3, 12);
    expect(ok("pi").value).toBeCloseTo(Math.PI, 12);
  });
});

describe("compute evaluator — result formatting", () => {
  it("returns the raw double and a 12-significant-digit normalization", () => {
    const result = ok("((1520-1470)/1470)*100");
    expect(result.value).toBe(3.4013605442176873);
    expect(result.text).toBe("3.40136054422");
  });

  it("normalizes float noise so judges compare human-stated figures", () => {
    const result = ok("0.1+0.2");
    expect(result.value).toBe(0.30000000000000004);
    expect(result.text).toBe("0.3");
  });
});

describe("compute evaluator — honest errors", () => {
  it("names the allowlist for an unknown identifier", () => {
    const message = err("tau + 1");
    expect(message).toContain("tau");
    expect(message).toContain("pi");
    expect(message).toContain("min");
  });

  it("names the allowlist for an unknown function", () => {
    const message = err("sin(0)");
    expect(message).toContain("sin");
    expect(message).toContain("sqrt");
  });

  it("rejects malformed expressions with the position", () => {
    expect(err("(1+2").length).toBeGreaterThan(0);
    expect(err("1+2)")).toBeTruthy();
    expect(err("2 2")).toBeTruthy();
    expect(err("1 + * 2")).toBeTruthy();
    expect(err(".")).toBeTruthy();
    expect(err("5.")).toBeTruthy();
    expect(err("1e")).toBeTruthy();
    expect(err("")).toBeTruthy();
    expect(err("   ")).toBeTruthy();
    expect(err("\u0000")).toBeTruthy();
    expect(err("round(1,)")).toBeTruthy();
  });

  it("enforces arity", () => {
    expect(err("round()")).toContain("round");
    expect(err("pow(2)")).toContain("pow");
    expect(err("min()")).toContain("min");
  });

  it("bounds round's decimal places to 0-12", () => {
    expect(err("round(1.5, 13)")).toContain("0");
    expect(err("round(1.5, -1)")).toBeTruthy();
    expect(err("round(1.5, 0.5)")).toBeTruthy();
  });

  it("reports division by zero instead of Infinity", () => {
    expect(err("1/0")).toContain("division by zero");
    expect(err("5 % 0")).toContain("division by zero");
    expect(err("1/(2-2)")).toContain("division by zero");
  });

  it("reports the offending operation for non-finite results", () => {
    expect(err("ln(0)")).toContain("ln");
    expect(err("sqrt(-1)")).toContain("sqrt");
    expect(err("exp(1000)")).toContain("exp");
  });

  it("caps expression length", () => {
    expect(COMPUTE_MAX_EXPR).toBeGreaterThan(0);
    const tooLong = "1+" + "1".repeat(COMPUTE_MAX_EXPR);
    expect(tooLong.length).toBeGreaterThan(COMPUTE_MAX_EXPR);
    expect(err(tooLong)).toContain(String(COMPUTE_MAX_EXPR));
    // The boundary itself still evaluates.
    expect(ok("1+1").value).toBe(2);
  });

  it("caps parenthesization depth, not honest nesting", () => {
    const at = "(".repeat(COMPUTE_MAX_DEPTH) + "1" + ")".repeat(COMPUTE_MAX_DEPTH);
    expect(ok(at).value).toBe(1);
    const over = "(".repeat(COMPUTE_MAX_DEPTH + 1) + "1" + ")".repeat(COMPUTE_MAX_DEPTH + 1);
    expect(err(over)).toContain(String(COMPUTE_MAX_DEPTH));
    // Function arguments nest like parens for depth purposes.
    const deepArgs = "min(1,".repeat(COMPUTE_MAX_DEPTH + 1) + "1" + ")".repeat(COMPUTE_MAX_DEPTH + 1);
    expect(err(deepArgs)).toContain(String(COMPUTE_MAX_DEPTH));
  });

  it("never throws — every failure is a returned error", () => {
    for (const expression of ["", ")))((", "${x}", "1\u00a02", "a".repeat(600)]) {
      expect(() => evaluateComputeExpression(expression)).not.toThrow();
    }
  });
});

describe("compute evaluator — not a code-execution surface", () => {
  it("contains no dynamic evaluation in its own source", () => {
    // The security property is structural — an expression evaluator with no
    // code-execution primitives cannot execute model-written code. This pins
    // that the module never grows one back.
    expect(COMPUTE_SOURCE).not.toMatch(/\beval\s*\(/);
    expect(COMPUTE_SOURCE).not.toMatch(/new\s+Function/);
    expect(COMPUTE_SOURCE).not.toMatch(/\bFunction\s*\(/);
    expect(COMPUTE_SOURCE).not.toMatch(/\bimport\s*\(/);
    expect(COMPUTE_SOURCE).not.toMatch(/\b(?:spawn|exec|execSync|fork)\s*\(/);
  });
});
