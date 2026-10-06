import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/init.ts";
import { MANAGED_MARKER } from "../src/lib/skill-install.ts";

// init only asks whether credentials exist; keep that answer deterministic
// instead of depending on the machine's real ~/.apo/credentials.
vi.mock("../src/lib/credentials.ts", () => ({
  readCredentials: () => null,
}));

function captureLog(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

const FAKE_ARGS_FILE = join(tmpdir(), "apo-init-fake-agent-args.txt");

/** Fake agent binaries: dump their argv to FAKE_ARGS_FILE via the env. */
function fakeAgentScript(): string {
  return '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FAKE_ARGS_FILE"\n';
}

let fakeBin = "";
let home = "";
let projectRoot = "";
let realPath = "";

beforeAll(() => {
  fakeBin = mkdtempSync(join(tmpdir(), "apo-init-bin-"));
  for (const binary of ["claude", "cursor"]) {
    writeFileSync(join(fakeBin, binary), fakeAgentScript(), "utf-8");
    chmodSync(join(fakeBin, binary), 0o755);
  }

  home = mkdtempSync(join(tmpdir(), "apo-init-home-"));
  projectRoot = mkdtempSync(join(tmpdir(), "apo-init-proj-"));

  realPath = process.env.PATH ?? "";
  process.env.PATH = fakeBin;
  process.env.FAKE_ARGS_FILE = FAKE_ARGS_FILE;
});

afterAll(() => {
  process.env.PATH = realPath;
  delete process.env.FAKE_ARGS_FILE;
  rmSync(fakeBin, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(FAKE_ARGS_FILE, { force: true });
});

function freshHome(): string {
  const h = mkdtempSync(join(tmpdir(), "apo-init-home-case-"));
  return h;
}

describe("apo init", () => {
  it("installs the skill to both locations with --no-launch and spawns nothing", async () => {
    const caseHome = freshHome();
    rmSync(FAKE_ARGS_FILE, { force: true });
    const { logs, restore } = captureLog();
    try {
      const code = await run(["--no-launch"], { home: caseHome, projectRoot });
      expect(code).toBe(0);
      expect(existsSync(join(caseHome, ".agents", "skills", "apo", "SKILL.md"))).toBe(true);
      expect(existsSync(join(caseHome, ".claude", "skills", "apo", "SKILL.md"))).toBe(true);
      expect(existsSync(join(caseHome, ".claude", "skills", "apo", MANAGED_MARKER))).toBe(true);
      // claude IS detected here (fake binary) — --no-launch must still not spawn.
      expect(existsSync(FAKE_ARGS_FILE)).toBe(false);
      expect(logs.join("\n")).not.toContain("Open which coding agent?");
    } finally {
      restore();
      rmSync(caseHome, { recursive: true, force: true });
    }
  });

  it("launches claude with acceptEdits and the kickoff prompt via --agent", async () => {
    const caseHome = freshHome();
    rmSync(FAKE_ARGS_FILE, { force: true });
    const { restore } = captureLog();
    try {
      const code = await run(["--agent", "claude-code"], { home: caseHome, projectRoot });
      expect(code).toBe(0);
      const args = readFileSync(FAKE_ARGS_FILE, "utf-8");
      expect(args).toContain("--permission-mode");
      expect(args).toContain("acceptEdits");
      expect(args).toContain("Set up apo in this repository.");
      expect(args).toContain("Never edit the task to make a run pass");
    } finally {
      restore();
      rmSync(caseHome, { recursive: true, force: true });
    }
  });

  it("opens cursor on the project and prints the /apo chat instruction", async () => {
    const caseHome = freshHome();
    rmSync(FAKE_ARGS_FILE, { force: true });
    const { logs, restore } = captureLog();
    try {
      const code = await run(["--agent", "cursor"], { home: caseHome, projectRoot });
      expect(code).toBe(0);
      expect(readFileSync(FAKE_ARGS_FILE, "utf-8").trim()).toBe(".");
      expect(logs.join("\n")).toContain("type /apo");
    } finally {
      restore();
      rmSync(caseHome, { recursive: true, force: true });
    }
  });

  it("does not spawn a picker-defaulted agent in a non-TTY without --agent", async () => {
    const caseHome = freshHome();
    rmSync(FAKE_ARGS_FILE, { force: true });
    const { logs, restore } = captureLog();
    try {
      // Non-TTY stdin: pickOption returns the default (detected claude), and
      // init must report how to launch for real instead of spawning into a pipe.
      const code = await run([], { home: caseHome, projectRoot });
      expect(code).toBe(0);
      expect(existsSync(FAKE_ARGS_FILE)).toBe(false);
      expect(logs.join("\n")).toContain("apo init --agent claude-code");
    } finally {
      restore();
      rmSync(caseHome, { recursive: true, force: true });
    }
  });

  it("notes the missing login instead of blocking", async () => {
    const caseHome = freshHome();
    const { logs, restore } = captureLog();
    try {
      await run(["--no-launch"], { home: caseHome, projectRoot });
      expect(logs.join("\n")).toContain("Not logged in");
    } finally {
      restore();
      rmSync(caseHome, { recursive: true, force: true });
    }
  });

  it("rejects an unknown --agent value", async () => {
    const caseHome = freshHome();
    const { errors, restore } = captureLog();
    try {
      const code = await run(["--agent", "bogus"], { home: caseHome, projectRoot });
      expect(code).toBe(1);
      expect(errors.join("\n")).toContain("Unknown agent 'bogus'");
    } finally {
      restore();
      rmSync(caseHome, { recursive: true, force: true });
    }
  });
});
