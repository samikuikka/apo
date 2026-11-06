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

  it("prints '-' in Started for a run that never started, not the 1970 epoch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse([makeRun({ status: "error", pass_result: null, started_at: null })]),
    );
    const { logs, restore } = captureLog();
    await run(["--backend", "http://backend.test"]);
    restore();

    expect(stripAnsi(logs.join("\n"))).not.toContain("1970");
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

  it("encodes repeatable --model/--effort as repeated query params", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse([]));
    const { logs, restore } = captureLog();

    await run([
      "--backend",
      "http://backend.test",
      "--model",
      "gpt-5.6-terra",
      "--model",
      "claude-opus-4.1",
      "--effort",
      "high",
    ]);
    restore();

    const url = String(fetchMock.mock.calls[0]?.[0]);
    // Repeatable params become repeated ?model=... entries (OR within dimension).
    expect(url).toContain("model=gpt-5.6-terra");
    expect(url).toContain("model=claude-opus-4.1");
    expect(url).toContain("effort=high");
    expect(logs.join("\n")).toContain("No runs found");
  });

  it("joins repeated --environment with commas and sends each --label as its own param", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse([]));
    const { logs, restore } = captureLog();

    await run([
      "--backend", "http://backend.test",
      "--environment", "staging",
      "--environment", "prod",
      "--label", "customer:acme",
      "--label", "customer:globex",
    ]);
    restore();

    const url = String(fetchMock.mock.calls[0]?.[0]);
    // apiGet builds the query with URLSearchParams: ',' and ':' arrive encoded.
    expect(url).toContain("environment=staging%2Cprod");
    expect(url).toContain("label=customer%3Aacme");
    expect(url).toContain("label=customer%3Aglobex");
    expect(logs.join("\n")).toContain("No runs found");
  });

  it("exits 2 on a malformed --label before making the request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse([]));
    const { errors, restore } = captureError();

    const code = await run([
      "--backend", "http://backend.test",
      "--label", "nocolon",
    ]);
    restore();

    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("--label must be <key>:<id>");
  });

  it("renders the Execution column from run_configuration", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse([
        makeRun({
          run_configuration: { model: "gpt-5.6-terra", effort: "high" },
        }),
        makeRun({ id: "no-cfg-run-aaaaaaaaaaaaaaaaaaaaaaaa", run_configuration: null }),
      ]),
    );
    const { logs, restore } = captureLog();

    await run(["--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("Execution");
    expect(out).toContain("gpt-5.6-terra · high");
    // A run with no configuration shows a dash.
    expect(out).toContain("·");
  });

  it("surfaces generation errors instead of showing an ordinary scored run", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse([
        makeRun({
          status: "error",
          pass_result: null,
          total_cost: 369_100,
          generation_execution: {
            total: 22,
            errored: 17,
            error_finish_reasons: { error: 17 },
          },
        }),
      ]),
    );
    const { logs, restore } = captureLog();

    await run(["--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("Generations");
    expect(out).toContain("17/22 error");
    expect(out).toContain("partial");
    expect(out).not.toContain("FAIL");
  });
});

describe("runs list --limit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies --limit to --json output, not just the table", async () => {
    // Regression: the JSON branch returned before the client-side limit
    // slice, so --limit was silently ignored in machine-readable mode.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      mockResponse([makeRun(), makeRun({ id: "run-2" }), makeRun({ id: "run-3" })]),
    );
    const { logs, restore } = captureLog();

    const code = await run(["--backend", "http://backend.test", "--limit", "2", "--json"]);

    restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n")) as unknown[];
    expect(parsed).toHaveLength(2);
  });
});
