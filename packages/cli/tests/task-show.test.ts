import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as credentials from "../src/lib/credentials.ts";
import { run } from "../src/commands/task-show.ts";
import { stripAnsi } from "../src/lib/format.ts";

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  return { logs, restore: () => { console.log = original; } };
}

function captureError(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  return { errors, restore: () => { console.error = original; } };
}

function mockDetail(): Record<string, unknown> {
  return {
    id: "real-agent/documents/data-extraction",
    task_path: "real-agent/documents/data-extraction",
    folder_path: "real-agent/documents",
    display_name: "data-extraction",
    adapter_name: "realAgentAdapter",
    has_checks: true,
    tags: ["documents", "smoke"],
    description: "Extract structured data from an invoice.",
    run_stats: {
      total_runs: 5,
      passed_runs: 2,
      failed_runs: 2,
      errored_runs: 1,
      pass_rate: 0.4,
      avg_duration_ms: 3200,
      last_run_at: "2026-08-21T15:13:32Z",
      last_run_status: "failed",
      last_run_passed: false,
      total_checks: 10,
      checks_pass_rate: 0.5,
      avg_cost: 0.0002,
      not_started_runs: 3,
    },
    latest_run: {
      id: "run_db3993122048ce4a55a06e2b",
      status: "failed",
    },
  };
}

describe("task show", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints display name, run stats, and latest run for a catalog task", async () => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue({
      backend_url: "http://backend.test",
      api_key: "sk-test",
      project: "proj-x",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/health")) return new Response("ok", { status: 200 });
      if (url.includes("/agent-tasks/")) {
        return new Response(JSON.stringify(mockDetail()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    });
    const { logs, restore } = captureLog();

    const code = await run(["real-agent/documents/data-extraction"]);

    restore();
    const out = stripAnsi(logs.join("\n"));
    expect(code).toBe(0);
    expect(out).toContain("Name:        data-extraction");
    expect(out).toContain("Description: Extract structured data from an invoice.");
    expect(out).toContain("Runs:        5 total · 2 passed · 2 failed · 1 errored (40% pass) · avg 3.2s");
    expect(out).toContain("Not started: 3 (ended before an executor started them)");
    expect(out).toContain("run_db3993122048ce4a55a06e2b");
    expect(out).toContain("Tags:        documents, smoke");
  });

  it("names the universe in the not-found error", async () => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue({
      backend_url: "http://backend.test",
      api_key: "sk-test",
      project: "proj-x",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/health")) return new Response("ok", { status: 200 });
      return new Response(JSON.stringify({ detail: "Task not found in inventory." }), { status: 404 });
    });
    const { errors, restore } = captureError();

    const code = await run(["nope"]);

    restore();
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("backend catalog (project proj-x)");
  });

  it("exits 2 with a fix hint when an explicit task root is missing", async () => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue(null);
    const { errors, restore } = captureError();

    const code = await run(["--dir", "/nonexistent-apo-task-root", "some-task"]);

    restore();
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Task root not found");
  });

  it("prints Description for a local task and nothing for one without", async () => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue(null);
    const root = mkdtempSync(join(tmpdir(), "apo-task-show-desc-"));
    const described = join(root, "described");
    mkdirSync(described, { recursive: true });
    writeFileSync(
      join(described, "described.eval.ts"),
      'task("described", { adapter: a, description: "Extract structured data from an invoice." });\n',
    );
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "plain.eval.ts"), 'task("plain", { adapter: a });\n');

    try {
      let { logs, restore } = captureLog();
      let code = await run(["--dir", root, "described"]);
      restore();
      const withDesc = stripAnsi(logs.join("\n"));
      expect(code).toBe(0);
      expect(withDesc).toContain("Adapter:     a");
      expect(withDesc).toContain("Description: Extract structured data from an invoice.");

      ({ logs, restore } = captureLog());
      code = await run(["--dir", root, "plain"]);
      restore();
      const withoutDesc = stripAnsi(logs.join("\n"));
      expect(code).toBe(0);
      expect(withoutDesc).not.toContain("Description:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
