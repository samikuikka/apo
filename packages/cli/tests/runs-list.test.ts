import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/runs-list.ts";
import { stripAnsi } from "../src/lib/format.ts";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

const FULL_ID = "0123456789abcdef0123456789abcdef";

function makeRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FULL_ID,
    task_id: "code-review",
    batch_run_id: "batch-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    status: "passed",
    pass_result: true,
    started_at: "2026-06-29T10:00:00Z",
    completed_at: "2026-06-29T10:00:03Z",
    total_cost: 0.01,
    total_checks: 2,
    passed_checks: 2,
    failed_checks: 0,
    adapter_name: "demoAdapter",
    ...overrides,
  };
}

describe("runs list command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the Batch column linking each run to its batch", async () => {
    // Regression: the flat runs list must show batch id so agents can group
    // task runs by their parent batch without a separate lookup.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse([makeRun({ batch_run_id: "batch-1234567890abcdef" })]),
    );
    const { logs, restore } = captureLog();

    const code = await run(["--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("Batch");
    // batch_run_id is truncated to 8 chars for the table column.
    expect(out).toContain("batch-12");
  });

  it("returns exit code 2 when the backend is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"));
    const { errors, restore } = captureError();

    const code = await run(["--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Cannot connect to backend");
  });

  it("prints 'No runs found' for an empty list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse([]));
    const { logs, restore } = captureLog();

    const code = await run(["--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    expect(stripAnsi(logs.join("\n"))).toContain("No runs found");
  });
});
