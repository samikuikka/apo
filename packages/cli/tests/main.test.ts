import { describe, expect, it, vi } from "vitest";
import { main } from "../src/main.ts";
import * as credentials from "../src/lib/credentials.ts";
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
    expect(logs[0]).toMatch(/^apo \d+\.\d+\.\d+$/);
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
    expect(logs.join("\n")).toContain("task publish");
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
      "task list", "task run", "task publish", "runs list", "runs show",
      "traces list", "traces show", "batch list", "batch show",
      "runs delete", "batch delete", "runs export",
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

  it("does not document removed execution-target flags on task run --help", async () => {
    const { output, code } = await runCapture(["task", "run", "--help"]);
    expect(code).toBe(0);
    // --local, --executor, and --remote no longer exist as flags and must not
    // appear in help.
    expect(output).not.toContain("--local");
    expect(output).not.toContain("--executor");
    expect(output).not.toContain("--remote");
    expect(output).not.toContain("--ci");
  });

  it("documents the implicit-local precedence in the task run note", async () => {
    const { output } = await runCapture(["task", "run", "--help"]);
    // The note should mention that local execution can be implicit (task/project).
    expect(output).toMatch(/execution|implicit|project default/i);
  });



  it("shows task publish help with dir and dry-run options", async () => {
    const { output, code } = await runCapture(["task", "publish", "--help"]);
    expect(code).toBe(0);
    expect(output).toContain("--dry-run");
    expect(output).toContain("--dir");
  });

  it("shows project create help with name arg and required email/password", async () => {
    const { output, code } = await runCapture(["project", "create", "--help"]);
    expect(code).toBe(0);
    expect(output).toContain("apo project create");
    expect(output).toContain("<name>");
    expect(output).toContain("--email");
    expect(output).toContain("--password");
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

  it("resolves the longest three-word command to traces import langfuse", async () => {
    const { output, code } = await runCapture(["traces", "import", "langfuse", "--help"]);
    expect(code).toBe(0);
    expect(output).toContain("apo traces import langfuse");
    expect(output).toContain("<trace-id>");
    expect(output).toContain("--langfuse-host");
    expect(output).toContain("--max-observations");
    expect(output).toContain("LANGFUSE_PUBLIC_KEY");
    expect(output).toContain("LANGFUSE_SECRET_KEY");
    expect(output).toContain("LANGFUSE_HOST");
    expect(output).toContain("Examples:");
    expect(output).toMatch(/environment-only|never leave/i);
    expect(output).toMatch(/exit code|0.*imported.*2|2.*fail/i);
  });

  it("lists traces import langfuse in the global command list", async () => {
    const { output } = await runCapture(["--help"]);
    expect(output).toContain("traces import langfuse");
  });
});

describe("unknown flag rejection", () => {
  it("returns 2 for an unknown flag on a matched command", async () => {
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: string) => { errors.push(msg); };

    const code = await main(["runs", "list", "--bogus-flag"]);

    console.error = origErr;
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Unknown option: --bogus-flag");
    expect(errors.join("\n")).toContain("apo runs list --help");
  });

  it("returns 2 for an unknown global flag with no command", async () => {
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: string) => { errors.push(msg); };

    const code = await main(["--bogus-flag"]);

    console.error = origErr;
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Unknown option: --bogus-flag");
  });

  it("still prints help exit 0 for a known global flag with no command", async () => {
    const { output, code } = await runCapture(["--json"]);
    expect(code).toBe(0);
    expect(output).toContain("Commands");
  });

  it("passes --flag=value through validation to the handler", async () => {
    // --limit=2 must be accepted (a real runs list flag) and reach the
    // handler; the mocked fetch rejects so runs list exits 2 on reachability
    // — proving dispatch happened instead of silent flag-dropping.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const spy = vi.spyOn(credentials, "readCredentials").mockReturnValue(null);
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: string) => { errors.push(msg); };

    const code = await main(["runs", "list", "--limit=2"]);

    console.error = origErr;
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Cannot connect to backend");
    spy.mockRestore();
    vi.restoreAllMocks();
  });
});
