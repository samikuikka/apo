import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../api-client";
import {
  getProjectAgentTask,
  listTaskRuns,
} from "../agent-task-api";

vi.mock("../api-client", () => ({
  apiClient: vi.fn(),
}));

describe("listTaskRuns", () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });

  it("uses the non-conflicting task-run collection endpoint", async () => {
    vi.mocked(apiClient).mockResolvedValue([]);

    await listTaskRuns("real-agent/documents/data-extraction", "project-1");

    expect(apiClient).toHaveBeenCalledWith("/v1/agent-task-runs", {
      cache: "no-store",
      query: {
        task_id: "real-agent/documents/data-extraction",
        project: "project-1",
      },
    });
  });
});

describe("getProjectAgentTask", () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });

  it("resolves a hierarchical task id through the project collection", async () => {
    vi.mocked(apiClient).mockResolvedValue([
      {
        id: "claude-agent/data-extraction",
        task_path: "/tasks/claude-agent/data-extraction",
        folder_path: "claude-agent",
        display_name: "data-extraction",
        adapter_name: "claudeAdapter",
        has_checks: true,
        has_user_simulator: false,
        tags: [],
        run_stats: null,
      },
    ]);

    const task = await getProjectAgentTask(
      "project-1",
      "claude-agent/data-extraction",
    );

    expect(apiClient).toHaveBeenCalledWith(
      "/v1/projects/project-1/agent-tasks",
      {
        cache: "no-store",
        query: { grep: "claude-agent/data-extraction" },
      },
    );
    expect(task.id).toBe("claude-agent/data-extraction");
    expect(task.latest_run).toBeNull();
  });

  it("does not accept a partial grep match as the requested task", async () => {
    vi.mocked(apiClient).mockResolvedValue([
      {
        id: "other/claude-agent/data-extraction-copy",
        task_path: "/tasks/other/claude-agent/data-extraction-copy",
        folder_path: "other/claude-agent",
        display_name: "data-extraction-copy",
        adapter_name: "claudeAdapter",
        has_checks: true,
        has_user_simulator: false,
        tags: [],
        run_stats: null,
      },
    ]);

    await expect(
      getProjectAgentTask("project-1", "claude-agent/data-extraction"),
    ).rejects.toMatchObject({
      status: 404,
      message: "Task not found in inventory.",
    });
  });
});
