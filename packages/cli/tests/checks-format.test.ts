import { describe, expect, it } from "vitest";
import { formatChecks } from "../src/lib/checks-format.ts";
import { stripAnsi } from "../src/lib/format.ts";
import type { CheckResult } from "../src/lib/agent-task-types.ts";

const MINUS = "\u2212";

describe("formatChecks", () => {
  describe("passing checks", () => {
    it("renders compactly without reasoning in default mode", () => {
      const checks: CheckResult[] = [
        { id: "has-summary", pass: true, reasoning: "looked good" },
      ];
      const out = stripAnsi(formatChecks(checks));

      expect(out).toContain("PASS has-summary");
      expect(out).not.toContain("looked good");
    });

    it("shows reasoning for passing checks in verbose mode", () => {
      const checks: CheckResult[] = [
        { id: "has-summary", pass: true, reasoning: "looked good" },
      ];
      const out = stripAnsi(formatChecks(checks, true));

      expect(out).toContain("PASS has-summary");
      expect(out).toContain("looked good");
    });
  });

  describe("failing checks with assertions", () => {
    it("renders expected/received diff for failing assertions", () => {
      const checks: CheckResult[] = [
        {
          id: "used-search",
          pass: false,
          reasoning: "agent never searched",
          assertions: [
            {
              id: 'calledTool("search_content")',
              pass: false,
              reasoning: "got 0 calls",
              expected: '\u22651 "search_content" call',
              received: "0",
            },
          ],
        },
      ];
      const out = stripAnsi(formatChecks(checks));

      expect(out).toContain("FAIL used-search");
      expect(out).toContain("agent never searched");
      expect(out).toContain(`${MINUS} Expected: \u22651 "search_content" call`);
      expect(out).toContain("+ Received: 0");
    });

    it("renders source location for failing assertions", () => {
      const checks: CheckResult[] = [
        {
          id: "c",
          pass: false,
          reasoning: "bad",
          assertions: [
            {
              id: "is-json",
              pass: false,
              reasoning: "nope",
              location: { file: "checks.ts", line: 42, column: 5 },
            },
          ],
        },
      ];
      const out = stripAnsi(formatChecks(checks));

      expect(out).toContain("checks.ts:42:5");
    });

    it("renders location without column when absent", () => {
      const checks: CheckResult[] = [
        {
          id: "c",
          pass: false,
          reasoning: "bad",
          assertions: [
            {
              id: "a",
              pass: false,
              reasoning: "nope",
              location: { file: "checks.ts", line: 7 },
            },
          ],
        },
      ];
      const out = stripAnsi(formatChecks(checks));

      expect(out).toContain("checks.ts:7");
      expect(out).not.toContain("checks.ts:7:");
    });

    it("hides passing assertions in default mode", () => {
      const checks: CheckResult[] = [
        {
          id: "c",
          pass: false,
          reasoning: "partial",
          assertions: [
            { id: "ok-assertion", pass: true, reasoning: "fine" },
            {
              id: "bad-assertion",
              pass: false,
              reasoning: "broke",
              expected: "x",
              received: "y",
            },
          ],
        },
      ];
      const out = stripAnsi(formatChecks(checks));

      expect(out).not.toContain("ok-assertion");
      expect(out).toContain("bad-assertion");
    });

    it("shows passing assertions in verbose mode", () => {
      const checks: CheckResult[] = [
        {
          id: "c",
          pass: true,
          reasoning: "all good",
          assertions: [
            { id: "ok-assertion", pass: true, reasoning: "fine" },
          ],
        },
      ];
      const out = stripAnsi(formatChecks(checks, true));

      expect(out).toContain("ok-assertion");
    });

    it("falls back to reasoning when assertion has no expected/received", () => {
      const checks: CheckResult[] = [
        {
          id: "c",
          pass: false,
          reasoning: "check failed",
          assertions: [
            { id: "prose-only", pass: false, reasoning: "the value was wrong" },
          ],
        },
      ];
      const out = stripAnsi(formatChecks(checks));

      expect(out).toContain("the value was wrong");
      expect(out).not.toContain(MINUS + " Expected");
    });
  });

  describe("checks without assertions", () => {
    it("shows check-level location for a failed check", () => {
      const checks: CheckResult[] = [
        {
          id: "llm-judge",
          pass: false,
          reasoning: "judge said no",
          location: { file: "checks.ts", line: 10 },
        },
      ];
      const out = stripAnsi(formatChecks(checks));

      expect(out).toContain("FAIL llm-judge");
      expect(out).toContain("at checks.ts:10");
    });

    it("shows judge response in verbose mode", () => {
      const checks: CheckResult[] = [
        {
          id: "quality",
          pass: false,
          reasoning: "poor quality",
          judge: {
            model: "gemini-flash",
            response: "The findings lack specificity.",
          },
        },
      ];
      const out = stripAnsi(formatChecks(checks, true));

      expect(out).toContain("gemini-flash");
      expect(out).toContain("The findings lack specificity.");
    });

    it("does not show judge response in default mode", () => {
      const checks: CheckResult[] = [
        {
          id: "quality",
          pass: false,
          reasoning: "poor quality",
          judge: { model: "gemini-flash", response: "secret details" },
        },
      ];
      const out = stripAnsi(formatChecks(checks));

      expect(out).not.toContain("secret details");
    });

    it("omits location line when check has no location", () => {
      const checks: CheckResult[] = [
        { id: "bare", pass: false, reasoning: "just failed" },
      ];
      const out = stripAnsi(formatChecks(checks));

      expect(out).not.toContain(" at ");
      expect(out).toContain("FAIL bare");
      expect(out).toContain("just failed");
    });
  });

  describe("multiple checks", () => {
    it("renders a mix of passing and failing checks", () => {
      const checks: CheckResult[] = [
        { id: "pass-1", pass: true, reasoning: "ok" },
        {
          id: "fail-1",
          pass: false,
          reasoning: "bad",
          assertions: [
            {
              id: "a",
              pass: false,
              reasoning: "diff",
              expected: "1",
              received: "2",
            },
          ],
        },
        { id: "pass-2", pass: true, reasoning: "ok" },
      ];
      const out = stripAnsi(formatChecks(checks));

      expect(out).toContain("PASS pass-1");
      expect(out).toContain("FAIL fail-1");
      expect(out).toContain("PASS pass-2");
      expect(out).toContain(`${MINUS} Expected: 1`);
      expect(out).toContain("+ Received: 2");
    });
  });
});
