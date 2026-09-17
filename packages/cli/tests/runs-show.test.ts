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

    it("manifests huge received/deliverable in --json (no content dumped)", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse(bloatyRun()));
      const { logs, restore } = captureLog();

      await run([FULL_ID, "--backend", "http://backend.test", "--json"]);
      restore();

      const out = logs.join("\n");
      expect(out).toContain("20,000 chars — apo runs deliverable");
      // The full deliverable body must not be present — manifest only.
      // (A single "Z" survives in ISO timestamps, so check for a run of Z's.)
      expect(out).not.toContain("Z".repeat(5));
    });

    it("manifests huge received in human output by default", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse(bloatyRun()));
      const { logs, restore } = captureLog();

      await run([FULL_ID, "--backend", "http://backend.test"]);
      restore();

      const out = stripAnsi(logs.join("\n"));
      expect(out).toContain("memo omits non-compete analysis");
      expect(out).toContain("20,000 chars — apo runs deliverable");
      expect(out).not.toContain("Z".repeat(5));
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

  // Issue #94: an unpriced call must not let a run total masquerade as
  // complete. The CLI marks the cost line "(partial — N unpriced calls)".
  it("marks the cost total as partial when unpriced calls are present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeRun({ total_cost: 279, unpriced_call_count: 2 })),
    );
    const { logs, restore } = captureLog();

    await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("partial");
    expect(out).toContain("2 unpriced calls");
  });

  it("does not mark the cost as partial when all calls are priced", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeRun({ total_cost: 5831, unpriced_call_count: 0 })),
    );
    const { logs, restore } = captureLog();

    await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).not.toContain("partial");
    expect(out).not.toContain("unpriced");
  });

  it("shows errored generations and marks cost and tokens as partial", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeRun({
        status: "error",
        pass_result: null,
        total_cost: 369_100,
        total_tokens: 12_345,
        generation_execution: {
          total: 22,
          errored: 17,
          error_finish_reasons: { error: 17 },
        },
      })),
    );
    const { logs, restore } = captureLog();

    await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("Generations:");
    expect(out).toContain("17/22 errored");
    expect(out).toContain("error ×17");
    expect(out).toMatch(/Cost:.*partial/);
    expect(out).toMatch(/Tokens:.*partial/);
  });

  it("prints model time and reasoning with the call that dominates each", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeRun({
        total_tokens: 21_000,
        total_model_time_ms: 58_538,
        max_call_latency_ms: 7_419,
        max_call_latency_call_id: "8c68d098872c5aab",
        total_reasoning_tokens: 5_492,
        max_call_reasoning_tokens: 1_054,
        max_call_reasoning_call_id: "2e1e24fa23cfff6c",
      })),
    );
    const { logs, restore } = captureLog();

    await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("Reasoning: 5,492 tok · max 1,054 in one call (observation 2e1e24fa23cfff6c)");
    expect(out).toContain("Slowest call: 7s (observation 8c68d098872c5aab)");
    expect(out).toContain("Model time: 59s");
    expect(out).not.toContain("not reported");
  });

  it("marks reasoning unknown when the provider never reported it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeRun({
        total_tokens: 4_000,
        total_model_time_ms: 900,
        total_reasoning_tokens: null,
      })),
    );
    const { logs, restore } = captureLog();

    await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    // Unknown, not zero: "not reported" reads differently from "didn't think".
    expect(out).toContain("Reasoning: not reported (provider did not send reasoning usage)");
  });

  it("omits the reasoning line when no generation reported reasoning", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeRun({
        total_tokens: null,
        total_model_time_ms: 3_000,
        max_call_latency_ms: 2_000,
        max_call_latency_call_id: "a",
        total_reasoning_tokens: null,
      })),
    );
    const { logs, restore } = captureLog();

    await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("Model time: 3s");
    expect(out).not.toContain("Reasoning:");
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

  it("shows the corrected-test count in the Checks header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(
        makeRun({
          status: "passed",
          pass_result: true,
          passed_checks: 3,
          total_checks: 3,
          failed_checks: 0,
          corrected_tests: 1,
        }),
      ),
    );
    const { logs, restore } = captureLog();
    await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toMatch(/Checks:\s+3\/3 passed \(0 failed\) · 1 corrected/);
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

  it("returns exit code 1 with --exit-status when a run has no verdict", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeRun({ status: "error", pass_result: null })),
    );
    const { restore } = captureLog();
    const code = await run([FULL_ID, "--backend", "http://backend.test", "--exit-status"]);
    restore();

    expect(code).toBe(1);
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

  // Issue #126: printTranscript read role/content fields that the SDK's
  // TaskTranscriptTurn ({ turnNumber, userAction, agentResponse }) never has,
  // so every turn rendered as [?] "". Fix: handle the real shape.
  it("renders SDK TaskTranscriptTurns in --verbose", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(
        makeRun({
          status: "passed",
          pass_result: true,
          transcript_json: {
            turns: [
              {
                turnNumber: 1,
                userAction: "Please draft the memo.",
                agentResponse: "Here is the draft...",
              },
              {
                turnNumber: 2,
                userAction: "Add a conclusion.",
                agentResponse: "Done.",
              },
            ],
          },
        }),
      ),
    );
    const { logs, restore } = captureLog();

    await run([FULL_ID, "--backend", "http://backend.test", "--verbose"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("Turn 1");
    expect(out).toContain("[user]");
    expect(out).toContain("Please draft the memo.");
    expect(out).toContain("[agent]");
    expect(out).toContain("Here is the draft...");
    expect(out).toContain("Turn 2");
    expect(out).not.toContain("[?]");
  });
});

// Issue #298: canonical run ids (run_ + 24 hex = 28 chars) fell under the
// old "< 32 chars means prefix" threshold, so `runs show <full-id>` resolved
// through the 1000-run listing window and failed for any run outside it.
describe("runs show full canonical id (issue #298)", () => {
  const CANONICAL_ID = "run_7e99888dfb3dd44e7f0fb197";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches a 28-char canonical id directly — no listing request first", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockResponse(makeRun({ id: CANONICAL_ID })));
    const { logs, restore } = captureLog();

    const code = await run([CANONICAL_ID, "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://backend.test/v1/agent-task-runs/${CANONICAL_ID}`,
    );
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain(CANONICAL_ID);
  });

  it("explains a prefix miss instead of reporting a run the backend never saw", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse([]));
    const { errors, restore } = captureError();

    const code = await run(["run_deadbee", "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(2);
    const out = stripAnsi(errors.join("\n"));
    expect(out).toContain("run_deadbee");
    expect(out).toMatch(/full run id/i);
    expect(out).not.toContain("Backend error");
  });
});

describe("runs show heartbeat visibility (issue #176)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the last heartbeat age for a live run", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(
        makeRun({
          status: "running",
          pass_result: null,
          completed_at: null,
          heartbeat_at: new Date(Date.now() - 40_000).toISOString(),
        }),
      ),
    );
    const { logs, restore } = captureLog();

    await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("Last beat:");
    expect(out).toMatch(/40s ago/);
    // Fresh beat — not flagged as at risk.
    expect(out).not.toContain("lease at risk");
  });

  it("flags a stale beat stream as a lease risk for a live run", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(
        makeRun({
          status: "running",
          pass_result: null,
          completed_at: null,
          heartbeat_at: new Date(Date.now() - 200_000).toISOString(),
        }),
      ),
    );
    const { logs, restore } = captureLog();

    await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("Last beat:");
    expect(out).toContain("lease at risk");
  });

  it("does not show heartbeat noise on terminal runs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(
        makeRun({
          heartbeat_at: new Date(Date.now() - 200_000).toISOString(),
        }),
      ),
    );
    const { logs, restore } = captureLog();

    await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).not.toContain("Last beat:");
  });
});

// Issue #309: run-level reasoning and per-call timing rollups — the summary
// must surface "one call thought for 4 minutes" without opening traces.
describe("runs show reasoning and timing rollups (issue #309)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints reasoning total, the deepest call, slowest call, and model time", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(
        makeRun({
          total_reasoning_tokens: 45_678,
          max_call_reasoning_tokens: 12_345,
          max_call_reasoning_call_id: "abcdef0123456789",
          max_call_latency_ms: 252_000,
          max_call_latency_call_id: "fedcba9876543210",
          total_model_time_ms: 750_000,
        }),
      ),
    );
    const { logs, restore } = captureLog();

    await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toMatch(/Reasoning: 45,678 tok/);
    expect(out).toContain("max 12,345 in one call");
    expect(out).toContain("observation abcdef0123456789");
    expect(out).toMatch(/Slowest call: 4m 12s/);
    expect(out).toContain("observation fedcba9876543210");
    expect(out).toMatch(/Model time: 12m 30s/);
    expect(out).toContain("excludes tool/harness time");
  });

  it("prints unknown reasoning explicitly — never as zero", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(
        makeRun({
          total_reasoning_tokens: null,
          total_tokens: 5_000,
        }),
      ),
    );
    const { logs, restore } = captureLog();

    await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("Reasoning: not reported");
    expect(out).not.toMatch(/Reasoning: 0/);
  });

  it("prints a reported zero reasoning total without the unknown notice", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(
        makeRun({
          total_reasoning_tokens: 0,
          max_call_reasoning_tokens: 0,
          max_call_reasoning_call_id: "0000000000000001",
        }),
      ),
    );
    const { logs, restore } = captureLog();

    await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toMatch(/Reasoning: 0 tok/);
    expect(out).not.toContain("not reported");
  });

  it("omits the timing lines for legacy payloads without them", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeRun()),
    );
    const { logs, restore } = captureLog();

    await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    // Tokens are present without any reasoning datum → the explicit
    // unknown line, but no timing lines at all.
    expect(out).toContain("Reasoning: not reported");
    expect(out).not.toContain("Slowest call:");
    expect(out).not.toContain("Model time:");
  });
});
