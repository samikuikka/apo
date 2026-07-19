import { describe, it, expect } from "vitest";

import { getSafeRedirectPath } from "../redirect";

describe("getSafeRedirectPath", () => {
  describe("happy path", () => {
    it("passes a normal path through", () => {
      expect(getSafeRedirectPath("/dashboard")).toBe("/dashboard");
    });

    it("preserves query strings and fragments", () => {
      expect(getSafeRedirectPath("/traces?id=123#details")).toBe(
        "/traces?id=123#details",
      );
    });

    it("returns default for undefined input", () => {
      expect(getSafeRedirectPath(undefined)).toBe("/");
    });

    it("returns default for null input", () => {
      expect(getSafeRedirectPath(null)).toBe("/");
    });

    it("returns default for empty string", () => {
      expect(getSafeRedirectPath("")).toBe("/");
    });

    it("passes root path through", () => {
      expect(getSafeRedirectPath("/")).toBe("/");
    });
  });

  describe("attack vectors blocked", () => {
    it("blocks protocol-relative URL", () => {
      expect(getSafeRedirectPath("//evil.com")).toBe("/");
    });

    it("blocks backslash trick", () => {
      expect(getSafeRedirectPath("/\\evil.com")).toBe("/");
    });

    it("blocks absolute HTTPS URL", () => {
      expect(getSafeRedirectPath("https://evil.com")).toBe("/");
    });

    it("blocks absolute HTTP URL", () => {
      expect(getSafeRedirectPath("http://evil.com")).toBe("/");
    });

    it("blocks JavaScript URI", () => {
      expect(getSafeRedirectPath("javascript:alert(1)")).toBe("/");
    });

    it("blocks data URI", () => {
      expect(getSafeRedirectPath("data:text/html,<script>alert(1)</script>")).toBe(
        "/",
      );
    });

    it("blocks vbscript URI", () => {
      expect(getSafeRedirectPath("vbscript:msgbox(1)")).toBe("/");
    });

    it("blocks file URI", () => {
      expect(getSafeRedirectPath("file:///etc/passwd")).toBe("/");
    });

    it("blocks JavaScript URI prefixed with slash", () => {
      expect(getSafeRedirectPath("/javascript:alert(1)")).toBe("/");
    });

    it("blocks data URI prefixed with slash", () => {
      expect(getSafeRedirectPath("/data:text/html,<script>")).toBe("/");
    });

    it("blocks uppercase JavaScript URI", () => {
      expect(getSafeRedirectPath("JavaScript:alert(1)")).toBe("/");
    });

    it("strips control character then validates path", () => {
      expect(getSafeRedirectPath("/\x00admin")).toBe("/admin");
    });

    it("blocks null byte between slashes (becomes // after strip)", () => {
      expect(getSafeRedirectPath("/\x00/admin")).toBe("/");
    });

    it("strips leading whitespace", () => {
      expect(getSafeRedirectPath(" /admin")).toBe("/admin");
    });

    it("strips tab and newline injection", () => {
      const result = getSafeRedirectPath("/admin\x0d\x0aSet-Cookie:evil=1");
      expect(result).toBe("/adminSet-Cookie:evil=1");
    });

    it("blocks protocol-relative URL after whitespace stripping", () => {
      expect(getSafeRedirectPath("  //evil.com")).toBe("/");
    });

    it("blocks backslash trick after control-char stripping", () => {
      expect(getSafeRedirectPath("\x00/\\evil.com")).toBe("/");
    });
  });

  describe("idempotency", () => {
    it("is idempotent on a safe path", () => {
      const path = "/dashboard/users";
      expect(getSafeRedirectPath(getSafeRedirectPath(path))).toBe(path);
    });

    it("is idempotent on root path", () => {
      expect(getSafeRedirectPath(getSafeRedirectPath("/"))).toBe("/");
    });

    it("is idempotent on path with query string", () => {
      const path = "/traces?id=123#section";
      expect(getSafeRedirectPath(getSafeRedirectPath(path))).toBe(path);
    });
  });

  describe("edge cases", () => {
    it("preserves unicode paths", () => {
      expect(getSafeRedirectPath("/ünicode/path")).toBe("/ünicode/path");
    });

    it("does not decode percent-encoded characters", () => {
      expect(getSafeRedirectPath("/%2F%2Fevil.com")).toBe("/%2F%2Fevil.com");
    });

    it("collapses mid-path double slashes", () => {
      expect(getSafeRedirectPath("/dashboard//traces")).toBe("/dashboard/traces");
    });

    it("blocks leading triple slashes (protocol-relative)", () => {
      expect(getSafeRedirectPath("///evil.com")).toBe("/");
    });

    it("returns default for whitespace-only string", () => {
      expect(getSafeRedirectPath("   ")).toBe("/");
    });

    it("returns default for control-char-only string", () => {
      expect(getSafeRedirectPath("\x00\x01\x02")).toBe("/");
    });
  });
});
