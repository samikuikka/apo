import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/runs-show.ts";
import { stripAnsi } from "../src/lib/format.ts";

const MINUS = "\u2212";

const FULL_ID = "0123456789abcdef0123456789abcdef";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

function captureError(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  return { errors, restore: () => { console.error = original; } };
}

function makeRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FULL_ID,
    task_id: "code-review",
    task_path: "tasks/code-review",
    batch_run_id: "batch-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    adapter_name: "demoAdapter",
    status: "failed",
    pass_result: false,
    started_at: "2026-06-29T10:00:00Z",
    completed_at: "2026-06-29T10:00:03Z",
    trace_run_id: "trace-1",
    error_message: null,
    total_cost: 0.01,
    total_tokens: 120,
    total_checks: 1,
    passed_checks: 0,
    failed_checks: 1,
    trigger: {
      source: "cli",
      actor: "test-user",
      hostname: "h",
      entrypoint: "apo runs show",
    },
    checks_json: null,
    deliverables_json: null,
    transcript_json: null,
    ...overrides,
  };
}

describe("runs show command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and prints a run by full id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeRun()),
    );
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://backend.test/v1/agent-task-runs/${FULL_ID}`,
    );
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain(FULL_ID);
    expect(out).toContain("code-review");
    expect(out).toContain("trace-1");
  });

  it("surfaces the batch id with a navigation hint", async () => {
    // Regression: the batch id must be visible so agents/users can navigate
    // from a task run to its parent batch (apo batch show <id>).
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeRun({ batch_run_id: "batch-1234567890abcdef" })),
    );
    const { logs, restore } = captureLog();

    await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("Batch:");
    expect(out).toContain("batch-1234567890abcdef");
    expect(out).toContain("apo batch show batch-1234567890abcdef");
  });

  it("renders failing assertion diffs in checks output", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(
        makeRun({
          total_checks: 2,
          passed_checks: 1,
          failed_checks: 1,
          checks_json: [
            { id: "passing", pass: true, reasoning: "ok" },
            {
              id: "used-search",
              pass: false,
              reasoning: "agent never searched",
              assertions: [
                {
                  id: 'calledTool("search_content")',
                  pass: false,
                  reasoning: "got 0",
                  expected: '\u22651 "search_content" call',
                  received: "0",
                  location: { file: "checks.ts", line: 20, column: 5 },
                },
              ],
            },
          ],
        }),
      ),
    );
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("FAIL used-search");
    expect(out).toContain('calledTool("search_content")');
    expect(out).toContain("checks.ts:20:5");
    expect(out).toContain(`${MINUS} Expected: \u22651 "search_content" call`);
    expect(out).toContain("+ Received: 0");
    expect(out).toContain("PASS passing");
  });

  it("emits raw JSON with --json flag", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeRun({ task_id: "json-task" })),
    );
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "--backend", "http://backend.test", "--json"]);
    restore();

    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain(`"id": "${FULL_ID}"`);
    expect(out).toContain('"json-task"');
  });

  // Issue #22: by default the per-check deliverable bloat (assertion
  // `received`, judge prompt/response, deliverable values) is previewed so
  // `runs show --json` isn't multi-MB; --full restores verbatim output.
  describe("deliverable bloat projection (#22)", () => {
    const HUGE = "Z".repeat(20_000);
    const bloatyRun = () =>
      makeRun({
        checks_json: [
          {
            id: "non-compete",
            pass: false,
            reasoning: "memo omits non-compete analysis",
            assertions: [
              {
                id: "judge",
                pass: false,
                reasoning: "no analysis",
                expected: "PASS when analyzed",
                received: HUGE,
                judge: { prompt: { system: "SYS\n" + HUGE }, response: "ok" },
              },
            ],
          },
        ],
        deliverables_json: { memo: HUGE },
      });

    it("previews huge received/deliverable in --json by default", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse(bloatyRun()));
      const { logs, restore } = captureLog();

      await run([FULL_ID, "--backend", "http://backend.test", "--json"]);
      restore();

      const out = logs.join("\n");
      expect(out).toContain("20,000 chars");
      expect(out).toContain("--full");
      // The full deliverable body must not be present — values above the
      // threshold are manifest-only (no content), so no long run of Z's.
      expect(out).not.toContain("Z".repeat(10));
    });

    it("emits verbatim received/deliverable with --json --full", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse(bloatyRun()));
      const { logs, restore } = captureLog();

      await run([FULL_ID, "--backend", "http://backend.test", "--json", "--full"]);
      restore();

      const out = logs.join("\n");
      expect(out).not.toContain("--full⟩");
      // The full value is present (appearances: received + deliverables_json).
      const matches = out.match(/ZZZZZZZZZZ/g) ?? [];
      expect(matches.length).toBeGreaterThan(0);
    });

    it("previews huge received in human output by default", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse(bloatyRun()));
      const { logs, restore } = captureLog();

      await run([FULL_ID, "--backend", "http://backend.test"]);
      restore();

      const out = stripAnsi(logs.join("\n"));
      expect(out).toContain("memo omits non-compete analysis");
      expect(out).toContain("20,000 chars");
      expect(out).toContain("--full");
      expect(out).not.toContain("Z".repeat(10));
    });
  });

  it("returns exit code 2 when run not found (404)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({ detail: "not found" }, 404),
    );
    const { errors, restore } = captureError();

    const code = await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(2);
    expect(stripAnsi(errors.join("\n"))).toContain("Run not found");
  });

  it("returns exit code 2 on connection failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new TypeError("fetch failed"),
    );
    const { restore } = captureError();

    const code = await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(2);
  });

  it("defaults to latest run when no run-id given", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(mockResponse([{ id: FULL_ID }]))
      .mockResolvedValueOnce(mockResponse(makeRun()));

    const { logs, restore } = captureLog();
    const code = await run(["--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("limit=1");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `http://backend.test/v1/agent-task-runs/${FULL_ID}`,
    );
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("(latest run)");
  });

  it("resolves latest run of a specific task with 'last --task'", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(mockResponse([{ id: FULL_ID }]))
      .mockResolvedValueOnce(mockResponse(makeRun()));

    const { restore } = captureLog();
    const code = await run(["last", "--task", "code-review", "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("task_id=code-review");
  });

  it("shows helpful error when no runs exist", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse([]));
    const { errors, restore } = captureError();

    const code = await run(["--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(2);
    expect(stripAnsi(errors.join("\n"))).toContain("No runs found");
  });

  it("returns exit code 1 with --exit-status on failed run", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeRun({ pass_result: false })),
    );
    const { restore } = captureLog();
    const code = await run([FULL_ID, "--backend", "http://backend.test", "--exit-status"]);
    restore();

    expect(code).toBe(1);
  });

  it("returns exit code 0 with --exit-status on passing run", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeRun({ pass_result: true, status: "passed" })),
    );
    const { restore } = captureLog();
    const code = await run([FULL_ID, "--backend", "http://backend.test", "--exit-status"]);
    restore();

    expect(code).toBe(0);
  });

  // Issue #8: a failed run with zero checks must explain itself, not render a
  // bare FAIL with an empty Checks section.
  it("prints the no-checks notice for a failed run with no checks", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(
        makeRun({
          status: "failed",
          pass_result: false,
          total_checks: 0,
          passed_checks: 0,
          failed_checks: 0,
          checks_json: [],
        }),
      ),
    );
    const { logs, restore } = captureLog();

    await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("No tests were registered");
    expect(out).toContain("test()");
  });
});
