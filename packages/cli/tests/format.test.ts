import { describe, expect, it } from "vitest";
import {
  green,
  red,
  yellow,
  bold,
  dim,
  cyan,
  formatJson,
  formatTable,
  passFail,
  formatTime,
} from "../src/lib/format.ts";

describe("color helpers", () => {
  it("green wraps with ANSI codes", () => {
    expect(green("ok")).toBe("\x1b[32mok\x1b[0m");
  });

  it("red wraps with ANSI codes", () => {
    expect(red("err")).toBe("\x1b[31merr\x1b[0m");
  });

  it("yellow wraps with ANSI codes", () => {
    expect(yellow("warn")).toBe("\x1b[33mwarn\x1b[0m");
  });

  it("bold wraps with ANSI codes", () => {
    expect(bold("title")).toBe("\x1b[1mtitle\x1b[0m");
  });

  it("dim wraps with ANSI codes", () => {
    expect(dim("subtle")).toBe("\x1b[2msubtle\x1b[0m");
  });

  it("cyan wraps with ANSI codes", () => {
    expect(cyan("info")).toBe("\x1b[36minfo\x1b[0m");
  });
});

describe("formatJson", () => {
  it("formats object as pretty JSON", () => {
    const result = formatJson({ id: 1, name: "test" });
    expect(result).toBe('{\n  "id": 1,\n  "name": "test"\n}');
  });

  it("formats array", () => {
    const result = formatJson([1, 2]);
    expect(result).toBe("[\n  1,\n  2\n]");
  });

  it("formats null", () => {
    expect(formatJson(null)).toBe("null");
  });
});

describe("formatTable", () => {
  it("formats headers and rows with padding", () => {
    const result = formatTable(["ID", "Name"], [["1", "Alice"], ["20", "Bob"]]);
    const lines = result.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("ID");
    expect(lines[0]).toContain("Name");
  });

  it("aligns columns to widest value", () => {
    const result = formatTable(["A", "B"], [["x", "yy"]]);
    const lines = result.split("\n");
    expect(lines[0]).toContain("B ");
    expect(lines[2]).toMatch(/^x {2}yy$/);
  });

  it("handles empty rows", () => {
    const result = formatTable(["Col"], []);
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Col");
  });
});

describe("passFail", () => {
  it("returns green PASS for true", () => {
    expect(passFail(true)).toBe("\x1b[32mPASS\x1b[0m");
  });

  it("returns red FAIL for false", () => {
    expect(passFail(false)).toBe("\x1b[31mFAIL\x1b[0m");
  });
});

describe("formatTime", () => {
  it("formats ISO string to locale string", () => {
    const result = formatTime("2026-06-02T12:00:00Z");
    expect(result).toBeTruthy();
    expect(result).not.toBe("2026-06-02T12:00:00Z");
  });

  it("returns Invalid Date for unparseable input", () => {
    const result = formatTime("not-a-date");
    expect(result).toBe("Invalid Date");
  });
});
