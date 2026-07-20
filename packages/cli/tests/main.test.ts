import { describe, expect, it } from "vitest";
import { main } from "../src/main.ts";
import { stripAnsi } from "../src/lib/format.ts";

async function runCapture(argv: string[]): Promise<{ output: string; code: number }> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  const code = await main(argv);
  console.log = origLog;
  return { output: stripAnsi(logs.join("\n")), code };
}

describe("main", () => {
  it("shows version with --version flag", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => { logs.push(msg); };

    const code = await main(["--version"]);

    console.log = origLog;
    expect(code).toBe(0);
    expect(logs[0]).toMatch(/^apo 0\.1\.0$/);
  });

  it("shows help with --help flag", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };

    const code = await main(["--help"]);

    console.log = origLog;
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("task list");
    expect(logs.join("\n")).toContain("runs list");
    expect(logs.join("\n")).toContain("batch list");
    expect(logs.join("\n")).toContain("project init-tasks");
    expect(logs.join("\n")).toContain("project sync-tasks");
  });

  it("shows help with no arguments", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };

    const code = await main([]);

    console.log = origLog;
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Commands");
  });

  it("returns 2 for unknown command", async () => {
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: string) => { errors.push(msg); };

    const code = await main(["unknown", "command"]);

    console.error = origErr;
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Unknown command");
  });
});

describe("global help", () => {
  it("includes Quick Start workflow", async () => {
    const { output, code } = await runCapture(["--help"]);
    expect(code).toBe(0);
    expect(output).toContain("Quick start");
    expect(output).toContain("apo login");
    expect(output).toContain("apo runs show <run-id>");
  });

  it("lists all commands", async () => {
    const { output } = await runCapture(["--help"]);
    for (const cmd of [
      "task list", "task run", "runs list", "runs show",
      "traces list", "traces show", "batch list", "batch show", "batch create",
      "project source show", "project init-tasks",
    ]) {
      expect(output).toContain(cmd);
    }
  });
});

describe("per-command help", () => {
  it("shows runs show help with usage, args, options, examples", async () => {
    const { output, code } = await runCapture(["runs", "show", "--help"]);
    expect(code).toBe(0);
    expect(output).toContain("apo runs show");
    expect(output).toContain("Usage:");
    expect(output).toContain("[run-id]");
    expect(output).toContain("--verbose");
    expect(output).toContain("Examples:");
    expect(output).toContain("apo runs show de89cab");
  });

  it("shows batch create help with required --tasks flag", async () => {
    const { output, code } = await runCapture(["batch", "create", "--help"]);
    expect(code).toBe(0);
    expect(output).toContain("--tasks");
    expect(output).toContain("required");
    expect(output).toContain("Examples:");
  });

  it("shows login help with its options", async () => {
    const { output, code } = await runCapture(["login", "--help"]);
    expect(code).toBe(0);
    expect(output).toContain("--force");
    expect(output).toContain("--email");
    expect(output).toContain("--project");
  });

  it("shows task run help with positional arg and exit codes note", async () => {
    const { output, code } = await runCapture(["task", "run", "--help"]);
    expect(code).toBe(0);
    expect(output).toContain("<task-id | path>");
    expect(output).toContain("0=pass");
  });

  it("shows project source set help with type options", async () => {
    const { output, code } = await runCapture(["project", "source", "set", "--help"]);
    expect(code).toBe(0);
    expect(output).toContain("--type");
    expect(output).toContain("git");
    expect(output).toContain("filesystem");
  });

  it("shows project create help with name arg and required email/password", async () => {
    const { output, code } = await runCapture(["project", "create", "--help"]);
    expect(code).toBe(0);
    expect(output).toContain("apo project create");
    expect(output).toContain("<name>");
    expect(output).toContain("--email");
    expect(output).toContain("--password");
    expect(output).toContain("--trace-content-policy");
  });

  it("falls back to global help for partial command (runs --help)", async () => {
    const { output, code } = await runCapture(["runs", "--help"]);
    expect(code).toBe(0);
    expect(output).toContain("Quick start");
    expect(output).not.toContain("Arguments:");
  });

  it("falls back to global help for unknown command --help", async () => {
    const { output, code } = await runCapture(["frobnicate", "--help"]);
    expect(code).toBe(0);
    expect(output).toContain("Quick start");
  });

  it("falls back to global help for logout (no extra sections)", async () => {
    const { output, code } = await runCapture(["logout", "--help"]);
    expect(code).toBe(0);
    expect(output).toContain("apo logout");
    expect(output).toContain("~/.apo/credentials");
  });
});
