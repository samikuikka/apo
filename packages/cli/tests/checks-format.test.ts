import { describe, expect, it } from "vitest";
import { formatChecks, NO_CHECKS_REGISTERED_MESSAGE } from "../src/lib/checks-format.ts";
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

  describe("corrected checks", () => {
    it("marks corrected tests and shows recorded result + provenance", () => {
      const checks: CheckResult[] = [
        {
          id: "report-is-complete",
          pass: true,
          reasoning: "judge missed the table",
          recorded_pass: false,
          correction: {
            id: "cor_1",
            action: "set_pass",
            pass_result: true,
            reason: "Retention is present in the KPI table",
            corrected_by_user_id: "u1",
            corrected_by_label: "u1@test.com",
            corrected_via: "api_key",
            created_at: "2026-08-25T12:00:00Z",
          },
        },
      ];
      const out = stripAnsi(formatChecks(checks));

      expect(out).toContain("PASS report-is-complete (corrected)");
      expect(out).toContain("recorded FAIL");
      expect(out).toContain("corrected by u1@test.com: Retention is present in the KPI table");
    });

    it("leaves uncorrected checks in today's shape", () => {
      const checks: CheckResult[] = [{ id: "plain", pass: true, reasoning: "ok" }];
      const out = stripAnsi(formatChecks(checks));
      expect(out).toContain("PASS plain");
      expect(out).not.toContain("corrected");
    });
  });

  describe("judge-errored checks (issue #323)", () => {
    it("renders NO VERDICT instead of FAIL for a check whose judge never answered", () => {
      const checks: CheckResult[] = [
        {
          id: "quality",
          pass: false,
          outcome: "error",
          reasoning: "judge failed: Judge API 503 after retry",
          assertions: [
            { id: "judge", pass: false, outcome: "error", reasoning: "judge failed: Judge API 503 after retry" },
          ],
        },
      ];
      const out = stripAnsi(formatChecks(checks));

      expect(out).toContain("NO VERDICT quality");
      expect(out).not.toContain("FAIL quality");
      // The transport error stays visible below the mark.
      expect(out).toContain("judge failed: Judge API 503");
    });

    it("keeps FAIL for a genuine failure even when a sibling assertion errored", () => {
      const checks: CheckResult[] = [
        {
          id: "mixed",
          pass: false,
          assertions: [
            { id: "struct", pass: false, reasoning: "expected 2" },
            { id: "judge", pass: false, outcome: "error", reasoning: "judge failed: timeout" },
          ],
        },
      ];
      const out = stripAnsi(formatChecks(checks));

      expect(out).toContain("FAIL mixed");
      // The errored assertion itself still reads as no-verdict, not ✗.
      expect(out).toContain("⚠ judge");
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

    // Issue #22: a judge `received` is often the whole deliverable (tens of
    // KB). It must become a manifest pointing at `apo runs deliverable` so the
    // concise reasoning stays the focus and the content is fetched once, not
    // re-dumped per criterion.
    it("manifests a huge received value by default and keeps the reasoning", () => {
      const huge = "X".repeat(20_000);
      const checks: CheckResult[] = [
        {
          id: "non-compete",
          pass: false,
          reasoning: "memo omits non-compete analysis",
          assertions: [
            {
              id: "judge",
              pass: false,
              reasoning: "The memorandum does not analyze non-compete enforceability.",
              expected: "PASS when analyzed",
              received: huge,
            },
          ],
        },
      ];
      const out = stripAnsi(formatChecks(checks));

      // Check-level reasoning (the concise, useful explanation) stays visible.
      expect(out).toContain("memo omits non-compete analysis");
      // Large received is a manifest, no content body.
      expect(out).toContain("20,000 chars — apo runs deliverable");
      expect(out).not.toContain("X");
    });

    it("leaves small received values unchanged (no manifest)", () => {
      const checks: CheckResult[] = [
        {
          id: "c",
          pass: false,
          reasoning: "r",
          assertions: [{ id: "a", pass: false, reasoning: "r", received: "0" }],
        },
      ];
      const out = stripAnsi(formatChecks(checks));

      expect(out).toContain("+ Received: 0");
      expect(out).not.toContain("apo runs deliverable");
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

  describe("describe() groups", () => {
    it("nests grouped checks under a roll-up header", () => {
      const checks: CheckResult[] = [
        { id: "R-0", pass: true, reasoning: "ok", group_id: "rules", group_name: "Rules" },
        { id: "R-1", pass: false, reasoning: "bad", group_id: "rules", group_name: "Rules" },
      ];
      const out = stripAnsi(formatChecks(checks));

      // Header carries the group name and a 1/2 tally.
      expect(out).toContain("▾ Rules · 1/2");
      // Both checks render under it.
      expect(out).toContain("PASS R-0");
      expect(out).toContain("FAIL R-1");
    });

    it("renders an all-passing group with a green tally", () => {
      const checks: CheckResult[] = [
        { id: "S-0", pass: true, reasoning: "", group_id: "safety", group_name: "Safety" },
        { id: "S-1", pass: true, reasoning: "", group_id: "safety", group_name: "Safety" },
      ];
      const out = stripAnsi(formatChecks(checks));
      expect(out).toContain("▾ Safety · 2/2");
    });

    it("leaves bare checks untouched and interleaves them with groups", () => {
      const checks: CheckResult[] = [
        { id: "bare", pass: true, reasoning: "ok" },
        { id: "R-0", pass: true, reasoning: "", group_id: "rules", group_name: "Rules" },
      ];
      const out = stripAnsi(formatChecks(checks));
      expect(out).toContain("PASS bare");
      expect(out).toContain("▾ Rules · 1/1");
      // Bare check appears before the group header (declaration order).
      expect(out.indexOf("PASS bare")).toBeLessThan(out.indexOf("▾ Rules"));
    });

    it("defaults the group label to the id when no name is present", () => {
      const checks: CheckResult[] = [
        { id: "R-0", pass: true, reasoning: "", group_id: "rules" },
      ];
      const out = stripAnsi(formatChecks(checks));
      expect(out).toContain("▾ rules · 1/1");
    });
  });
});

describe("NO_CHECKS_REGISTERED_MESSAGE", () => {
  // Issue #8: a run that ends with zero checks must explain itself instead of
  // printing a bare `FAIL <task>`. The message names `test()` because that's
  // the documented registration function (see apps/docs reference/task.md).
  it("names the test() registration function and the requirement", () => {
    const out = stripAnsi(NO_CHECKS_REGISTERED_MESSAGE);

    expect(out).toMatch(/no tests were registered/i);
    expect(out).toContain("test()");
    expect(out).toMatch(/at least one/i);
  });
});
