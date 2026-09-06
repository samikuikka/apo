/**
 * The task detail page's data fetch shape.
 *
 * One bounded list call serves the page: the scoped cohort at an explicit
 * page-aligned limit, and no unfiltered twin fetch for a count denominator
 * (that second 1,000-row scan per view was the read-hygiene problem).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const listTaskRunsMock = vi.fn().mockResolvedValue([]);

vi.mock("@/lib/agent-task-api", () => ({
  getProjectAgentTask: vi.fn().mockResolvedValue({
    id: "t",
    display_name: "t",
    adapter_name: "a",
    folder_path: "",
    has_checks: false,
    tags: [],
    run_stats: null,
  }),
  listTaskRuns: (...args: unknown[]) => listTaskRunsMock(...(args as [])),
}));

vi.mock("@/lib/agent-task-view-api", () => ({
  fetchTaskViewConfigFacets: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/projects-api", () => ({
  getProject: vi.fn().mockResolvedValue(null),
}));

import TaskDetailPage from "../page";

describe("TaskDetailPage run-history fetch", () => {
  beforeEach(() => {
    listTaskRunsMock.mockClear();
  });

  it("issues exactly one bounded listTaskRuns call", async () => {
    await TaskDetailPage({
      params: Promise.resolve({ projectId: "p", taskId: ["t"] }),
      searchParams: Promise.resolve({}),
    });

    expect(listTaskRunsMock).toHaveBeenCalledTimes(1);
    const [, , , limit] = listTaskRunsMock.mock.calls[0];
    expect(limit).toBe(200);
  });

  it("keeps the single bounded call when a scope is active", async () => {
    await TaskDetailPage({
      params: Promise.resolve({ projectId: "p", taskId: ["t"] }),
      searchParams: Promise.resolve({ model: "claude-opus-5" }),
    });

    expect(listTaskRunsMock).toHaveBeenCalledTimes(1);
    const [, , cohort, limit] = listTaskRunsMock.mock.calls[0];
    expect(String(cohort?.model)).toContain("claude-opus-5");
    expect(limit).toBe(200);
  });
});
