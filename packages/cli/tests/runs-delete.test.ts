/**
 * `apo runs delete <run-id>... --yes` — permanent run deletion.
 *
 * The --yes gate is the safety story: without it the command names what
 * would go and exits 2 without sending a DELETE. With it, every resolved
 * run is deleted sequentially and the counts are printed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/runs-delete.ts";
import { stripAnsi } from "../src/lib/format.ts";

const FULL_ID = "0123456789abcdef0123456789abcdef";
const OTHER_ID = "ffffffffffffffffffffffffffffffff";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deleted(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    deleted_runs: 1,
    deleted_traces: 1,
    deleted_calls: 3,
    deleted_batches: 0,
    ...overrides,
  };
}

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  return { logs, restore: () => (console.log = original) };
}

function captureError(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  return { logs, restore: () => (console.error = original) };
}

function requests(fetchMock: ReturnType<typeof vi.fn>): Array<{ url: string; method: string }> {
  return fetchMock.mock.calls.map((call) => ({
    url: String(call[0]),
    method: String(call[1]?.method ?? "GET"),
  }));
}

describe("runs delete command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends DELETE for a full run id with --yes and prints the counts", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(deleted()));
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "--yes"]);

    expect(code).toBe(0);
    const reqs = requests(fetchMock);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.method).toBe("DELETE");
    expect(reqs[0]!.url).toContain(`/v1/agent-task-runs/${FULL_ID}`);
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain(`${FULL_ID} deleted`);
    expect(out).toContain("1 trace");
    expect(out).toContain("Deleted 1 run");
    restore();
  });

  it("deletes multiple runs sequentially", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(deleted()))
      .mockResolvedValueOnce(jsonResponse(deleted({ deleted_runs: 1, deleted_batches: 1 })));
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, OTHER_ID, "--yes"]);

    expect(code).toBe(0);
    const urls = requests(fetchMock).map((r) => r.url).join(" ");
    expect(urls).toContain(`/v1/agent-task-runs/${FULL_ID}`);
    expect(urls).toContain(`/v1/agent-task-runs/${OTHER_ID}`);
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("empty batch removed");
    expect(out).toContain("Deleted 2 runs");
    restore();
  });

  it("dedupes repeated run ids", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(deleted()));

    const code = await run([FULL_ID, FULL_ID, "--yes"]);

    expect(code).toBe(0);
    expect(requests(fetchMock)).toHaveLength(1);
  });

  it("without --yes names the targets and exits 2 without deleting", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { logs } = captureLog();
    const { logs: errs, restore } = captureError();

    const code = await run([FULL_ID]);

    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stripAnsi(logs.join(" "))).toContain(`${FULL_ID} would be deleted`);
    expect(stripAnsi(errs.join(" "))).toMatch(/--yes/);
    restore();
  });

  it("resolves 'last' through the shared resolver before deleting", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([{ id: FULL_ID }]))
      .mockResolvedValueOnce(jsonResponse(deleted()));

    const code = await run(["last", "--yes"]);

    expect(code).toBe(0);
    const reqs = requests(fetchMock);
    expect(reqs[0]!.url).toContain("/v1/agent-task-runs");
    expect(reqs[0]!.method).toBe("GET");
    expect(reqs[1]!.method).toBe("DELETE");
    expect(reqs[1]!.url).toContain(`/v1/agent-task-runs/${FULL_ID}`);
  });

  it("supports --json for machine-readable output", async () => {
    const body = deleted();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(body));
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "--yes", "--json"]);

    expect(code).toBe(0);
    expect(JSON.parse(logs.join(""))).toEqual([{ run_id: FULL_ID, ...body }]);
    restore();
  });

  it("requires a run-id argument without fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { logs, restore } = captureError();

    const code = await run(["--yes"]);

    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs.join(" ")).toMatch(/run-id/);
    restore();
  });

  it("maps API error kinds to actionable messages with exit 2", async () => {
    for (const [status, detail, match] of [
      [409, "Run is still active — cancel it before deleting", /cancel it before deleting/],
      [404, "Task run not found", /Task run not found/],
      [403, "Project role required: admin", /Project role required/],
      [503, "artifact storage cleanup failed; the run was kept — retry deletion", /retry deletion/],
    ] as const) {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ detail }, status));
      const { logs, restore } = captureError();

      const code = await run([FULL_ID, "--yes"]);

      expect(code).toBe(2);
      expect(stripAnsi(logs.join(" "))).toMatch(match);
      restore();
    }
  });

  it("exits 2 with connection errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Cannot connect to backend"));
    const { logs, restore } = captureError();

    const code = await run([FULL_ID, "--yes"]);

    expect(code).toBe(2);
    expect(logs.join(" ")).toMatch(/Cannot connect|backend/i);
    restore();
  });
});

// Issue #298: canonical run ids (run_ + 24 hex = 28 chars) fell under the
// old "< 32 chars means prefix" threshold, so `runs delete <full-id>` first
// listed the 1000 most recent runs and reported a fabricated backend 404
// for any run outside that window — the backend deletes those runs happily.
describe("runs delete full canonical id (issue #298)", () => {
  const CANONICAL_ID = "run_7e99888dfb3dd44e7f0fb197"; // run_ + 24 hex = 28 chars

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes a 28-char canonical id directly without resolving through the run list", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(deleted()));
    const { logs, restore } = captureLog();

    const code = await run([CANONICAL_ID, "--yes"]);

    expect(code).toBe(0);
    const reqs = requests(fetchMock);
    expect(reqs).toHaveLength(1); // no list GET before the DELETE
    expect(reqs[0]!.method).toBe("DELETE");
    expect(reqs[0]!.url).toContain(`/v1/agent-task-runs/${CANONICAL_ID}`);
    expect(stripAnsi(logs.join("\n"))).toContain(`${CANONICAL_ID} deleted`);
    restore();
  });

  it("reports an honest miss instead of a fabricated backend 404 when a prefix matches nothing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse([]));
    const { logs, restore } = captureError();

    const code = await run(["run_deadbee", "--yes"]);

    expect(code).toBe(2);
    const out = stripAnsi(logs.join("\n"));
    expect(out).not.toContain("Backend error 404");
    expect(out).toContain("run_deadbee");
    expect(out).toMatch(/full run id/i);
    restore();
  });
});
