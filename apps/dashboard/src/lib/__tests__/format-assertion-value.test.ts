import { describe, expect, it } from "vitest";
import { formatAssertionValue } from "../format-assertion-value";

describe("formatAssertionValue", () => {
  it("shows a stored string preview without implying the full value is present", () => {
    expect(formatAssertionValue({ kind: "truncated", preview: '"Invoice INV-42', size_bytes: 5000, sha256: "abc" }))
      .toBe('"Invoice INV-42… [truncated]');
  });
  it("preserves strings and serializes structured values", () => {
    expect(formatAssertionValue("Invoice INV-42")).toBe("Invoice INV-42");
    expect(formatAssertionValue({ invoice: "INV-42" })).toBe('{"invoice":"INV-42"}');
    expect(formatAssertionValue(null)).toBe("null");
    expect(formatAssertionValue(false)).toBe("false");
  });
});
