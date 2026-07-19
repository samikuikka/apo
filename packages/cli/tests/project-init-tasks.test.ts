import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/project-init-tasks.ts";

describe("project init-tasks command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("configures and syncs a GitHub task source with a single command", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: false, client_id: null }), { status: 200 }))
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
            status: "pending_sync",
            last_synced_at: null,
            last_resolved_commit_sha: null,
            last_error: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
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
      "--repo",
      "owner/repo",
      "--subpath",
      "e2e/tasks",
    ]);

    console.log = originalLog;

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/v1/projects/proj-1/task-source");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/v1/projects/proj-1/task-source/sync");
    expect(logs.join("\n")).toContain("Initialized project tasks: proj-1");
    expect(logs.join("\n")).toContain("Tasks:       1");
  });
});
