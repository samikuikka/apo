/**
 * `apo runs rejudge` — replays Phase 2 against stored deliverables and
 * records a judgment. The SDK replay is mocked here (covered by its own
 * suite in packages/sdk); these tests cover flag handling, the judgment
 * POST, dry-run, and rendering.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/runs-rejudge.ts";
import { rejudgeTaskRun } from "@apo-ai/sdk/agent-task";
import { stripAnsi } from "../src/lib/format.ts";

vi.mock("@apo-ai/sdk/agent-task", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@apo-ai/sdk/agent-task")>()),
  rejudgeTaskRun: vi.fn(),
}));

const mockedRejudge = vi.mocked(rejudgeTaskRun);
const FULL_ID = "0123456789abcdef0123456789abcdef";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function runDetail(): Record<string, unknown> {
  return {
    id: FULL_ID,
    task_id: "demo/task",
    task_path: "/tasks/demo/task",
    status: "passed",
    pass_result: true,
    deliverables: [],
    task_definition: { id: "rev-pinned" },
    judgments_count: 0,
  };
}

function outcome() {
  return {
    runId: FULL_ID,
    taskId: "demo/task",
    definitionRevisionId: "rev-pinned",
    definitionRevisionIsPinned: true,
    judge: { model: "test/judge" },
    samples: 3,
    checks: [
      { id: "report-title", pass: true, reasoning: "passed" },
      { id: "judged-quality", pass: false, reasoning: "not grounded" },
    ],
    pass: false,
    stability: [
      { check_id: "report-title", passes: 3, samples: 3 },
      { check_id: "judged-quality", passes: 1, samples: 3 },
    ],
    traceSnapshotAvailable: false,
    taskDirUsed: null,
  };
}

function capture(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  return { logs, errors, restore: () => { console.log = log; console.error = err; } };
}

describe("runs rejudge command", () => {
  beforeEach(() => {
    mockedRejudge.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replays, prints results, and records a judgment", async () => {
    mockedRejudge.mockResolvedValue(outcome() as never);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      async () => jsonResponse(runDetail()),
    ).mockImplementationOnce(
      async () => jsonResponse({ id: "jdg_abc123", trigger: "rejudge" }, 201),
    );
    const { logs, restore } = capture();

    const code = await run([
      FULL_ID,
      "--backend", "http://backend.test",
      "--judge-model", "test/judge",
      "--samples", "3",
      "--label", "calibration",
    ]);
    restore();

    expect(code).toBe(0);
    // Replay called with resolved run id + endpoints + judge config.
    expect(mockedRejudge).toHaveBeenCalledTimes(1);
    const [runId, endpoints, options] = mockedRejudge.mock.calls[0]!;
    expect(runId).toBe(FULL_ID);
    expect(endpoints).toMatchObject({ backendUrl: "http://backend.test" });
    expect(options).toMatchObject({ judge: { model: "test/judge" }, samples: 3 });

    // Judgment POSTed with the replay outcome.
    const postUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(postUrl).toBe(`http://backend.test/v1/agent-task-runs/${FULL_ID}/judgments`);
    const postBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(postBody).toMatchObject({
      label: "calibration",
      judge_model: "test/judge",
      task_definition_revision_id: "rev-pinned",
      samples: 3,
    });
    expect(postBody.checks).toHaveLength(2);
    expect(postBody.stability).toHaveLength(2);

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("report-title");
    expect(out).toContain("judged-quality");
    expect(out).toContain("1/3"); // stability for the unstable check
    expect(out).toContain("jdg_abc123");
    expect(out).toContain("apo runs judgments");
  });

  it("dry-run performs no POST", async () => {
    mockedRejudge.mockResolvedValue(outcome() as never);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      async () => jsonResponse(runDetail()),
    );
    const { logs, restore } = capture();

    const code = await run([FULL_ID, "--backend", "http://backend.test", "--dry-run"]);
    restore();

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("Dry run");
    expect(out).toContain("no judgment recorded");
  });

  it("json output includes the judgment id", async () => {
    mockedRejudge.mockResolvedValue(outcome() as never);
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      async () => jsonResponse(runDetail()),
    ).mockImplementationOnce(
      async () => jsonResponse({ id: "jdg_json" }, 201),
    );
    const { logs, restore } = capture();

    const code = await run([
      FULL_ID, "--backend", "http://backend.test", "--json", "--judge-model", "test/judge",
    ]);
    restore();

    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.judgment_id).toBe("jdg_json");
    expect(parsed.checks.map((c: { id: string }) => c.id)).toEqual(["report-title", "judged-quality"]);
  });

  it("reports NO VERDICT and --exit-status 2 when only judge errors fail (issue #323)", async () => {
    mockedRejudge.mockResolvedValue({
      ...outcome(),
      samples: 1,
      checks: [
        { id: "report-title", pass: true, reasoning: "passed" },
        { id: "judged-quality", pass: false, reasoning: "judge failed: 504", outcome: "error" },
      ],
      stability: [],
    } as never);
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      async () => jsonResponse(runDetail()),
    );
    const { logs, restore } = capture();

    const code = await run([FULL_ID, "--backend", "http://backend.test", "--dry-run", "--exit-status"]);
    restore();

    expect(code).toBe(2);
    const out = stripAnsi(logs.join("\n"));
    expect(out).toMatch(/Verdict:.*— NO VERDICT/);
    expect(out).not.toMatch(/Verdict:.*— FAIL/);
  });

  it("--json carries noVerdict", async () => {
    mockedRejudge.mockResolvedValue({
      ...outcome(),
      samples: 1,
      checks: [{ id: "judged-quality", pass: false, reasoning: "judge failed: 504", outcome: "error" }],
      stability: [],
    } as never);
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      async () => jsonResponse(runDetail()),
    );
    const { logs, restore } = capture();

    const code = await run([FULL_ID, "--backend", "http://backend.test", "--dry-run", "--json"]);
    restore();

    expect(code).toBe(0);
    expect(JSON.parse(logs.join("\n")).noVerdict).toBe(true);
  });

  it("keeps --exit-status 1 for a genuine fail", async () => {
    mockedRejudge.mockResolvedValue(outcome() as never);
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      async () => jsonResponse(runDetail()),
    );
    const { restore } = capture();

    const code = await run([FULL_ID, "--backend", "http://backend.test", "--dry-run", "--exit-status"]);
    restore();

    expect(code).toBe(1);
  });

  it("refuses invalid samples", async () => {
    const { errors, restore } = capture();
    const code = await run([
      FULL_ID, "--backend", "http://backend.test", "--samples", "0",
    ]);
    restore();
    expect(code).toBe(2);
    expect(stripAnsi(errors.join("\n"))).toContain("--samples");
    expect(mockedRejudge).not.toHaveBeenCalled();
  });

  it("surfaces replay refusals as command errors", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      async () => jsonResponse(runDetail()),
    );
    mockedRejudge.mockRejectedValue(
      new Error("Refusing to replay run: deliverables are not ready: memo (failed)") as never,
    );
    const { errors, restore } = capture();

    const code = await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(2);
    expect(stripAnsi(errors.join("\n"))).toContain("not ready");
  });
});
