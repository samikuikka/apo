import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/project-sync-tasks.ts";

describe("project sync-tasks command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("syncs the configured project task source and reports task count", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            project: "proj-1",
            source_type: "git",
            display_name: "owner/repo",
            repository_url: "https://github.com/owner/repo.git",
            git_ref: "main",
            subpath: "e2e/tasks",
            filesystem_path: null,
            demo_seed_id: null,
            status: "ready",
            last_synced_at: "2026-06-22T06:00:00Z",
            last_resolved_commit_sha: "abc123",
            last_error: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "data-extraction",
              task_path: "tasks/data-extraction",
              folder_path: "tasks",
              display_name: "data-extraction",
              adapter_name: "realAgentAdapter",
              has_checks: true,
              has_user_simulator: true,
              tags: [],
              run_stats: null,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    const code = await run([
      "--backend",
      "http://backend.test",
      "--project",
      "proj-1",
    ]);

    console.log = originalLog;

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logs.join("\n")).toContain("Synced project tasks: proj-1");
    expect(logs.join("\n")).toContain("Tasks:   1");
  });
});
