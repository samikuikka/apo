import { describe, it, expect } from "vitest";
import { buildAssertionParam, parseOwnAssertionId } from "../assertion-select";

/**
 * Regression test for the cross-check drawer bleed bug.
 *
 * Every `t.judge()` call defaults its assertion id to "judge". Before the
 * fix, the drawer state was encoded as `?assertion=judge` — a bare assertion
 * id with no check context — so opening one check's judge drawer matched the
 * judge assertion in EVERY other check and opened their drawers too.
 *
 * The param is now namespaced `<checkId>::<assertionId>`. These tests prove
 * that a check only ever reacts to its own namespace.
 */
describe("assertion-select namespacing", () => {
  it("builds a namespaced param from check + assertion id", () => {
    expect(buildAssertionParam("answers-cover-the-questions", "judge"))
      .toBe("answers-cover-the-questions::judge");
  });

  it("returns null when there is no assertion to select (closes the drawer)", () => {
    expect(buildAssertionParam("any-check", undefined)).toBeNull();
  });

  it("matches the assertion when the check id owns it", () => {
    const param = buildAssertionParam("answers-cover-the-questions", "judge");
    expect(parseOwnAssertionId(param, "answers-cover-the-questions")).toBe("judge");
  });

  // ── THE REGRESSION: same assertion id, different checks ──────────────
  it("does NOT match when a different check owns the same assertion id", () => {
    // Check A opens its judge drawer → param is checkA::judge
    const paramFromCheckA = buildAssertionParam("answers-cover-the-questions", "judge");

    // Check B (also has a "judge" assertion) must NOT see it as its own.
    expect(parseOwnAssertionId(paramFromCheckA, "answers-grounded-in-spec")).toBeNull();
  });

  it("two checks with identical assertion ids open independently", () => {
    const checkA = "answers-cover-the-questions";
    const checkB = "answers-grounded-in-spec";

    // Opening A's judge drawer must not make B think its drawer should open.
    const aOpen = buildAssertionParam(checkA, "judge");
    expect(parseOwnAssertionId(aOpen, checkA)).toBe("judge");
    expect(parseOwnAssertionId(aOpen, checkB)).toBeNull();

    // And vice versa.
    const bOpen = buildAssertionParam(checkB, "judge");
    expect(parseOwnAssertionId(bOpen, checkB)).toBe("judge");
    expect(parseOwnAssertionId(bOpen, checkA)).toBeNull();
  });

  it("returns null for a malformed param (no namespace separator)", () => {
    // Legacy/un-namespaced value — e.g. an old bookmark with ?assertion=judge.
    expect(parseOwnAssertionId("judge", "answers-cover-the-questions")).toBeNull();
  });

  it("returns null for an empty param value", () => {
    expect(parseOwnAssertionId(null, "any-check")).toBeNull();
    expect(parseOwnAssertionId("", "any-check")).toBeNull();
  });

  it("handles assertion ids that themselves contain the separator", () => {
    // Edge case: if an assertion id ever contained "::", only the first split wins.
    const param = buildAssertionParam("my-check", "weird::id");
    expect(parseOwnAssertionId(param, "my-check")).toBe("weird::id");
    expect(parseOwnAssertionId(param, "other-check")).toBeNull();
  });
});
