import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Regression test for traces-show not forwarding the project query param.
 *
 * The traces-show command hits GET /v1/runs/{id}. The backend defaults
 * project to "default" when no ?project= param is sent, so traces belonging
 * to any other project 404. The fix: forward config.projectId as ?project=,
 * same as traces-list does.
 */

const FULL_ID = "0123456789abcdef0123456789abcdef";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function captureError(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  return { errors, restore: () => { console.error = original; } };
}

function makeTraceDetail(): Record<string, unknown> {
  return {
    run: {
      id: FULL_ID,
      task_id: "data-extraction",
      flow_name: "agent-task.data-extraction",
      status: "success",
      duration_ms: 5000,
      environment: "default",
      tags: [],
      created_at: "2026-07-14T18:12:37Z",
      completed_at: "2026-07-14T18:12:42Z",
    },
    calls: [],
    metrics: [],
  };
}

describe("traces show command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards the project query param when projectId is set", async () => {
    const { run } = await import("../src/commands/traces-show.ts");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeTraceDetail()),
    );

    await run([FULL_ID, "--backend", "http://backend.test", "--project", "my-project"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/runs/");
    expect(url).toContain("project=my-project");
  });

  it("returns 404 error when trace is not found", async () => {
    const { run } = await import("../src/commands/traces-show.ts");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({ detail: "Run not found" }, 404),
    );
    const { errors, restore } = captureError();

    const code = await run([FULL_ID, "--backend", "http://backend.test", "--project", "my-project"]);
    restore();

    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Trace not found");
  });
});
