/**
 * The task detail page when the task left the catalog.
 *
 * Inventory is replaced in-place on every source sync, so a renamed,
 * moved, or removed task 404s the inventory lookup while its recorded
 * runs still exist. The page must show that run evidence with a warning
 * instead of discarding it behind the 404 — and must not extend that
 * courtesy to other failures: an unreachable backend is an error, not a
 * "removed from catalog" claim.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api-error";

const mocks = vi.hoisted(() => ({
  getProjectAgentTask: vi.fn(),
  listTaskRuns: vi.fn(),
  taskRunHistory: vi.fn(),
}));

vi.mock("@/lib/agent-task-api", () => ({
  getProjectAgentTask: (...args: Parameters<typeof mocks.getProjectAgentTask>) =>
    mocks.getProjectAgentTask(...args),
  listTaskRuns: (...args: Parameters<typeof mocks.listTaskRuns>) =>
    mocks.listTaskRuns(...args),
  providerLabels: () => [],
}));

vi.mock("@/lib/agent-task-view-api", () => ({
  fetchTaskViewConfigFacets: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/projects-api", () => ({
  getProject: vi.fn().mockResolvedValue(null),
}));

vi.mock("../run-history-scope-bar", () => ({
  RunHistoryScopeBar: () => <div>scope-bar</div>,
}));

vi.mock("../task-run-history", () => ({
  TaskRunHistory: (props: unknown) => {
    mocks.taskRunHistory(props);
    return <div>run-history</div>;
  },
}));

vi.mock("@/components/agent-task-files/task-file-browser", () => ({
  TaskFileBrowser: () => <div>file-browser</div>,
}));

import TaskDetailPage from "../page";

const IN_CATALOG_TASK = {
  id: "t",
  display_name: "t",
  adapter_name: "a",
  folder_path: "",
  has_checks: true,
  tags: [],
  run_stats: null,
};

const PAGE_ARGS = {
  params: Promise.resolve({ projectId: "p", taskId: ["gone", "task"] }),
  searchParams: Promise.resolve({}),
};

describe("TaskDetailPage off-catalog degradation", () => {
  beforeEach(() => {
    mocks.getProjectAgentTask.mockReset();
    mocks.listTaskRuns.mockReset();
    mocks.taskRunHistory.mockReset();
  });

  it("shows historical runs with a warning when the task 404s", async () => {
    mocks.getProjectAgentTask.mockRejectedValue(
      new ApiError(404, "Task not found in inventory."),
    );
    const run = { id: "run-1", status: "passed" };
    mocks.listTaskRuns.mockResolvedValue([run]);

    render(await TaskDetailPage({ ...PAGE_ARGS }));

    expect(
      screen.getByText(/no longer in the project catalog/i),
    ).toBeInTheDocument();
    // The hierarchical id becomes the title when no display name exists.
    expect(screen.getByText("gone/task")).toBeInTheDocument();
    expect(mocks.taskRunHistory).toHaveBeenCalledWith(
      expect.objectContaining({ runs: [run] }),
    );
    // The Files tab reads from inventory and must not be offered.
    expect(screen.queryByText("Files")).not.toBeInTheDocument();
  });

  it("renders the dead-end message when the task 404s with no runs", async () => {
    mocks.getProjectAgentTask.mockRejectedValue(
      new ApiError(404, "Task not found in inventory."),
    );
    mocks.listTaskRuns.mockResolvedValue([]);

    render(await TaskDetailPage({ ...PAGE_ARGS }));

    expect(screen.getByText(/no runs were recorded/i)).toBeInTheDocument();
    expect(mocks.taskRunHistory).not.toHaveBeenCalled();
  });

  it("surfaces the error banner when the task lookup fails with something other than not-found", async () => {
    // A 500 or network failure must surface as an error, not render a
    // false "removed from catalog" page.
    mocks.getProjectAgentTask.mockRejectedValue(
      new ApiError(500, "inventory backend exploded"),
    );
    mocks.listTaskRuns.mockResolvedValue([]);

    render(await TaskDetailPage({ ...PAGE_ARGS }));

    expect(screen.getByText("inventory backend exploded")).toBeInTheDocument();
    expect(
      screen.queryByText(/no longer in the project catalog/i),
    ).not.toBeInTheDocument();
    expect(mocks.taskRunHistory).not.toHaveBeenCalled();
  });

  it("keeps the Files tab and hides the warning when the task is in the catalog", async () => {
    mocks.getProjectAgentTask.mockResolvedValue(IN_CATALOG_TASK);
    mocks.listTaskRuns.mockResolvedValue([]);

    render(await TaskDetailPage({ ...PAGE_ARGS }));

    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(
      screen.queryByText(/no longer in the project catalog/i),
    ).not.toBeInTheDocument();
  });
});
