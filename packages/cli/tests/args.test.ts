import { describe, expect, it } from "vitest";
import {
  parseArgs,
  requirePositional,
  getFlag,
  getBoolFlag,
} from "../src/lib/args.ts";

describe("parseArgs", () => {
  it("parses positional arguments", () => {
    const result = parseArgs(["task", "list"]);
    expect(result.positional).toEqual(["task", "list"]);
    expect(result.flags).toEqual({});
  });

  it("parses --help flag", () => {
    const result = parseArgs(["--help"]);
    expect(result.flags.help).toBe(true);
  });

  it("parses -h flag as help", () => {
    const result = parseArgs(["-h"]);
    expect(result.flags.help).toBe(true);
  });

  it("parses --version flag", () => {
    const result = parseArgs(["--version"]);
    expect(result.flags.version).toBe(true);
  });

  it("parses -v flag as version", () => {
    const result = parseArgs(["-v"]);
    expect(result.flags.version).toBe(true);
  });

  it("parses --json boolean flag", () => {
    const result = parseArgs(["--json"]);
    expect(result.flags.json).toBe(true);
  });

  it("parses --dir with value", () => {
    const result = parseArgs(["--dir", "/some/path"]);
    expect(result.flags.dir).toBe("/some/path");
  });

  it("parses --backend with value", () => {
    const result = parseArgs(["--backend", "http://localhost:9000"]);
    expect(result.flags.backend).toBe("http://localhost:9000");
  });

  it("parses flag with value as true when next arg starts with --", () => {
    const result = parseArgs(["--dir", "--json"]);
    expect(result.flags.dir).toBe(true);
    expect(result.flags.json).toBe(true);
  });

  it("parses flag with value as true when it is the last arg", () => {
    const result = parseArgs(["--dir"]);
    expect(result.flags.dir).toBe(true);
  });

  it("stops parsing at --", () => {
    const result = parseArgs(["task", "run", "--", "--help"]);
    expect(result.positional).toEqual(["task", "run"]);
    expect(result.flags.help).toBeUndefined();
  });

  it("parses mixed positional and flags", () => {
    const result = parseArgs(["task", "run", "meeting-summary", "--json", "--dir", "./e2e"]);
    expect(result.positional).toEqual(["task", "run", "meeting-summary"]);
    expect(result.flags.json).toBe(true);
    expect(result.flags.dir).toBe("./e2e");
  });

  it("handles empty argv", () => {
    const result = parseArgs([]);
    expect(result.positional).toEqual([]);
    expect(result.flags).toEqual({});
  });

  it("parses multiple flags with values", () => {
    const result = parseArgs([
      "--task", "my-task",
      "--status", "completed",
      "--limit", "10",
    ]);
    expect(result.flags.task).toBe("my-task");
    expect(result.flags.status).toBe("completed");
    expect(result.flags.limit).toBe("10");
  });
});

describe("requirePositional", () => {
  it("returns value at index", () => {
    expect(requirePositional(["a", "b"], 0, "first")).toBe("a");
    expect(requirePositional(["a", "b"], 1, "second")).toBe("b");
  });

  it("throws when index is missing", () => {
    expect(() => requirePositional(["a"], 1, "task-id")).toThrow(
      "Missing required argument: <task-id>",
    );
  });

  it("throws on empty array", () => {
    expect(() => requirePositional([], 0, "id")).toThrow(
      "Missing required argument: <id>",
    );
  });
});

describe("getFlag", () => {
  it("returns string flag value", () => {
    expect(getFlag({ dir: "/path" }, "dir")).toBe("/path");
  });

  it("returns undefined for boolean flag", () => {
    expect(getFlag({ json: true }, "json")).toBeUndefined();
  });

  it("returns undefined for missing flag", () => {
    expect(getFlag({}, "missing")).toBeUndefined();
  });
});

describe("getBoolFlag", () => {
  it("returns true for boolean true", () => {
    expect(getBoolFlag({ json: true }, "json")).toBe(true);
  });

  it("returns true for string 'true'", () => {
    expect(getBoolFlag({ json: "true" }, "json")).toBe(true);
  });

  it("returns false for false/missing", () => {
    expect(getBoolFlag({ json: false }, "json")).toBe(false);
    expect(getBoolFlag({}, "json")).toBe(false);
  });
});
