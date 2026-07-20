import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as credentials from "../src/lib/credentials.ts";

import { run } from "../src/commands/task-run.ts";

// Mock credentials so the test doesn't read the machine's real ~/.apo/credentials
// (which may carry a default_execution that would change dispatch — SPEC-136).
beforeEach(() => {
  vi.spyOn(credentials, "readCredentials").mockReturnValue(null);
});

let testDir: string;

function writeTaskFile(dir: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  // The task file is `<folder-name>.eval.ts` — the convention discovery and
  // loadTask actually scan for. Writing `task.ts` would not be found.
  const taskName = dir.split(/[\\/]/).pop() ?? "task";
  writeFileSync(join(dir, `${taskName}.eval.ts`), content);
}

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `apo-task-run-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });
});

describe("task run command", () => {
  it("uses backend batch run flow when backend is reachable", async () => {
    const taskDir = join(testDir, "meeting-summary");
    writeTaskFile(
      taskDir,
      `import { task } from "@apo/sdk/agent-task";\ntask("meeting-summary", { adapter: "a" });`,
    );

    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "batch-1",
            project: "example-service",
            selection_type: "task",
            selection_query: null,
            task_root: testDir,
            grep: null,
            environment: "default",
            status: "queued",
            total_tasks: 1,
            passed_tasks: 0,
            failed_tasks: 0,
            errored_tasks: 0,
            created_at: "2026-06-03T10:00:00Z",
            started_at: null,
            completed_at: null,
            run_metadata: {
              trigger: {
                source: "cli",
                actor: "test-user",
                hostname: "test-host",
                entrypoint: "apo task run",
                initiated_at: "2026-06-03T10:00:00Z",
              },
            },
            trigger: {
              source: "cli",
              actor: "test-user",
              hostname: "test-host",
              user_agent: null,
              entrypoint: "apo task run",
              initiated_at: "2026-06-03T10:00:00Z",
            },
            task_runs: [],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "batch-1",
            project: "example-service",
            selection_type: "task",
            selection_query: null,
            task_root: testDir,
            grep: null,
            environment: "default",
            status: "completed",
            total_tasks: 1,
            passed_tasks: 1,
            failed_tasks: 0,
            errored_tasks: 0,
            created_at: "2026-06-03T10:00:00Z",
            started_at: "2026-06-03T10:00:01Z",
            completed_at: "2026-06-03T10:00:03Z",
            run_metadata: {
              trigger: {
                source: "cli",
                actor: "test-user",
                hostname: "test-host",
                entrypoint: "apo task run",
                initiated_at: "2026-06-03T10:00:00Z",
              },
            },
            trigger: {
              source: "cli",
              actor: "test-user",
              hostname: "test-host",
              user_agent: null,
              entrypoint: "apo task run",
              initiated_at: "2026-06-03T10:00:00Z",
            },
            task_runs: [
              {
                id: "run-1",
                batch_run_id: "batch-1",
                task_id: "meeting-summary",
                task_path: taskDir,
                adapter_name: "demoAdapter",
                status: "passed",
                pass_result: true,
                started_at: "2026-06-03T10:00:01Z",
                completed_at: "2026-06-03T10:00:03Z",
                trace_run_id: "trace-1",
                error_message: null,
                total_cost: 0.01,
                total_checks: 2,
                passed_checks: 2,
                failed_checks: 0,
                trigger: {
                  source: "cli",
                  actor: "test-user",
                  hostname: "test-host",
                  user_agent: null,
                  entrypoint: "apo task run",
                  initiated_at: "2026-06-03T10:00:00Z",
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "run-1",
            batch_run_id: "batch-1",
            task_id: "meeting-summary",
            task_path: taskDir,
            adapter_name: "demoAdapter",
            status: "passed",
            pass_result: true,
            started_at: "2026-06-03T10:00:01Z",
            completed_at: "2026-06-03T10:00:03Z",
            trace_run_id: "trace-1",
            error_message: null,
            total_cost: 0.01,
            total_checks: 2,
            passed_checks: 2,
            failed_checks: 0,
            trigger: {
              source: "cli",
              actor: "test-user",
              hostname: "test-host",
              user_agent: null,
              entrypoint: "apo task run",
              initiated_at: "2026-06-03T10:00:00Z",
            },
            checks_json: [{ id: "check-1", pass: true }],
            transcript_json: { turns: [] },
            deliverables_json: { summary: { text: "ok" } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    const code = await run([
      "meeting-summary",
      "--dir",
      testDir,
      "--backend",
      "http://backend.test",
      "--project",
      "example-service",
      "--actor",
      "test-user",
    ]);

    console.log = originalLog;

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://backend.test/v1/agent-task-batch-runs");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
    });
    const postBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(postBody.run_metadata?.trigger?.source).toBe("cli");
    expect(postBody.run_metadata?.trigger?.actor).toBe("test-user");
    expect(typeof postBody.run_metadata?.trigger?.hostname).toBe("string");
    expect(postBody.run_metadata?.trigger?.entrypoint).toBe("apo task run");
    expect(logs.join("\n")).toContain("meeting-summary");
    expect(logs.join("\n")).toContain("trace-1");
  });
});
