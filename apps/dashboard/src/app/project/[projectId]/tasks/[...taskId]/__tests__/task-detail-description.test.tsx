/**
 * The task detail page owns the authored description: the one surface that
 * answers "what is this task for?" in full (the list card deliberately
 * stays dense). Renders only when the task declares one.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProjectAgentTask: vi.fn(),
  listTaskRuns: vi.fn(),
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
  TaskRunHistory: () => <div>run-history</div>,
}));

vi.mock("@/components/agent-task-files/task-file-browser", () => ({
  TaskFileBrowser: () => <div>file-browser</div>,
}));

import TaskDetailPage from "../page";

const describedTask = {
  id: "t",
  display_name: "t",
  adapter_name: "a",
  folder_path: "",
  has_checks: false,
  tags: [],
  run_stats: null,
  description: "Extract structured data from an invoice.",
};

const PAGE_ARGS = {
  params: Promise.resolve({ projectId: "p", taskId: ["t"] }),
  searchParams: Promise.resolve({}),
};

describe("TaskDetailPage description", () => {
  beforeEach(() => {
    mocks.getProjectAgentTask.mockReset();
    mocks.listTaskRuns.mockReset().mockResolvedValue([]);
  });

  it("renders the task's description under the header", async () => {
    mocks.getProjectAgentTask.mockResolvedValue(describedTask);

    const page = await TaskDetailPage(PAGE_ARGS);
    render(page);

    expect(
      await screen.findByText("Extract structured data from an invoice."),
    ).toBeInTheDocument();
  });

  it("renders no description block when the task declares none", async () => {
    mocks.getProjectAgentTask.mockResolvedValue({ ...describedTask, description: null });

    const page = await TaskDetailPage(PAGE_ARGS);
    render(page);

    expect(screen.queryByText(/Extract structured data/)).not.toBeInTheDocument();
  });
});
