/**
 * `apo runs judgments` — list a run's judgments (original + rejudges) or
 * read one judgment's full check evidence.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/runs-judgments.ts";
import { stripAnsi } from "../src/lib/format.ts";

const FULL_ID = "0123456789abcdef0123456789abcdef";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function judgment(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    task_run_id: FULL_ID,
    trigger: id === FULL_ID ? "original" : "rejudge",
    label: null,
    judge_model: "orig/judge",
    judge_base_url: null,
    task_definition_revision_id: "rev1",
    definition_revision_matches_run: true,
    samples: 1,
    pass_result: true,
    total_checks: 3,
    passed_checks: 2,
    failed_checks: 1,
    created_at: "2026-08-25T00:00:00Z",
    checks: null,
    stability: null,
    ...overrides,
  };
}

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  return { logs, restore: () => { console.log = original; } };
}

describe("runs judgments command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists original and rejudge judgments", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        task_run_id: FULL_ID,
        judgments: [
          judgment(FULL_ID),
          judgment("jdg_newest", { label: "sonnet calibration", judge_model: "anthropic/claude-sonnet-4.5", samples: 3 }),
        ],
      }),
    );
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://backend.test/v1/agent-task-runs/${FULL_ID}/judgments`,
    );
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("original");
    expect(out).toContain("rejudge");
    expect(out).toContain("jdg_newest");
    expect(out).toContain("sonnet calibration");
    expect(out).toContain("claude-sonnet-4.5");
    expect(out).toContain("2/3");
  });

  it("shows one judgment's full checks", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(
        judgment("jdg_newest", {
          checks: [
            { id: "report-title", pass: true, reasoning: "passed" },
            { id: "judged-quality", pass: false, reasoning: "not grounded" },
          ],
          stability: [{ check_id: "judged-quality", passes: 1, samples: 3 }],
        }),
      ),
    );
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "jdg_newest", "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://backend.test/v1/agent-task-runs/${FULL_ID}/judgments/jdg_newest`,
    );
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("judged-quality");
    expect(out).toContain("not grounded");
  });

  it("counts judge-errored samples apart from fails in stability (issue #323)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(
        judgment("jdg_newest", {
          errored_checks: 1,
          stability: [{ check_id: "judged-quality", passes: 2, samples: 3, errored: 1 }],
        }),
      ),
    );
    const { logs, restore } = captureLog();

    await run([FULL_ID, "jdg_newest", "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    // 2 passes of 2 judged samples; the third produced no verdict.
    expect(out).toMatch(/2\/2 \(1 no verdict\)/);
    expect(out).not.toContain("unstable");
    // The summary line carries the judgment-level no-verdict count.
    expect(out).toContain("1 no verdict");
  });

  it("json output", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ task_run_id: FULL_ID, judgments: [judgment(FULL_ID)] }),
    );
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "--backend", "http://backend.test", "--json"]);
    restore();

    expect(code).toBe(0);
    // Matches `runs list --json`: the bare array.
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].trigger).toBe("original");
  });

  it("rejects a missing run id", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await run([]);

    expect(code).toBe(2);
    expect(error).toHaveBeenCalledWith("Missing required argument: <run-id>");
  });
});
