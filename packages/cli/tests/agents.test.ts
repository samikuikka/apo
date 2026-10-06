import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  detectAgents,
  isBinaryInstalled,
  launchArgv,
} from "../src/lib/agents.ts";

let fakeBin = "";
let home = "";
let projectRoot = "";
let realPath = "";

beforeAll(() => {
  fakeBin = mkdtempSync(join(tmpdir(), "apo-agents-bin-"));
  writeFileSync(join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(fakeBin, "claude"), 0o755);

  home = mkdtempSync(join(tmpdir(), "apo-agents-home-"));
  projectRoot = mkdtempSync(join(tmpdir(), "apo-agents-proj-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(projectRoot, ".cursor"), { recursive: true });

  realPath = process.env.PATH ?? "";
  process.env.PATH = fakeBin;
});

afterAll(() => {
  process.env.PATH = realPath;
  rmSync(fakeBin, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("isBinaryInstalled", () => {
  it("finds a binary on PATH", () => {
    expect(isBinaryInstalled("claude")).toBe(true);
  });

  it("misses a binary that is not on PATH", () => {
    expect(isBinaryInstalled("codex")).toBe(false);
  });
});

describe("detectAgents", () => {
  it("reports both signals with a joined reason", () => {
    const signals = detectAgents(projectRoot, home);
    const claude = signals.find((s) => s.tool === "claude-code");
    expect(claude).toMatchObject({
      onPath: true,
      hasConfigDir: true,
      reason: "binary on PATH, config directory found",
    });
  });

  it("detects a tool through its project config dir alone", () => {
    const cursor = detectAgents(projectRoot, home).find((s) => s.tool === "cursor");
    expect(cursor).toMatchObject({ onPath: false, hasConfigDir: true });
  });

  it("reports not detected for an absent tool", () => {
    const gemini = detectAgents(projectRoot, home).find((s) => s.tool === "gemini-cli");
    expect(gemini).toMatchObject({ onPath: false, hasConfigDir: false, reason: "not detected" });
  });

  it("resolves ~ config dirs against the provided home, not $HOME", () => {
    const emptyHome = mkdtempSync(join(tmpdir(), "apo-agents-empty-"));
    try {
      const claude = detectAgents(projectRoot, emptyHome).find((s) => s.tool === "claude-code");
      expect(claude?.hasConfigDir).toBe(false);
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});

describe("launchArgv", () => {
  it("puts the prompt behind --permission-mode for Claude Code", () => {
    expect(launchArgv("claude-code", "do the thing")).toEqual([
      "--permission-mode",
      "acceptEdits",
      "do the thing",
    ]);
  });

  it("opens the project only for Cursor", () => {
    expect(launchArgv("cursor", "do the thing")).toEqual(["."]);
  });

  it("passes the prompt as a positional for codex, gemini, and opencode", () => {
    expect(launchArgv("codex-cli", "do the thing")).toEqual(["do the thing"]);
    expect(launchArgv("gemini-cli", "do the thing")).toEqual(["do the thing"]);
    expect(launchArgv("opencode", "do the thing")).toEqual(["do the thing"]);
  });
});
