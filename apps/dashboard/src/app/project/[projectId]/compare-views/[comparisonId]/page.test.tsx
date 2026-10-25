import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOverview: vi.fn(),
  listTasks: vi.fn(),
  renderClient: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
}));

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ "user-agent": "vitest" })),
}));

vi.mock("@/lib/agent-task-api", () => ({
  listProjectAgentTasks: mocks.listTasks,
}));

vi.mock("@/lib/agent-task-view-api", () => ({
  getTaskViewComparisonOverview: mocks.getOverview,
}));

vi.mock("./compare-views-client", () => ({
  CompareViewsClient: (props: unknown) => {
    mocks.renderClient(props);
    return <div>comparison loaded</div>;
  },
}));

import CompareViewsPage from "./page";

describe("CompareViewsPage", () => {
  beforeEach(() => {
    mocks.getOverview.mockReset();
    mocks.listTasks.mockReset();
    mocks.renderClient.mockReset();
  });

  it("hydrates from the lightweight overview, not bulk evidence", async () => {
    const snapshot = {
      id: "tvc_1",
      project_id: "project-1",
      view_a_config: { model: "kimi", effort: null, since: null },
      view_b_config: { model: "opus", effort: null, since: null },
      task_ids: ["task-1"],
      resolved: [{
        task_id: "task-1",
        a_run_id: "run-a",
        b_run_id: "run-b",
        a_status: "passed",
        b_status: "passed",
        state: "aligned",
      }],
      coverage: { both_run: 1, aligned: 1, scope: 1 },
      created_at: "2026-08-12T00:00:00Z",
      created_by: null,
    };
    const runs = [
      { id: "run-a", task_id: "task-1" },
      { id: "run-b", task_id: "task-1" },
    ];
    mocks.getOverview.mockResolvedValue({ snapshot, runs });
    mocks.listTasks.mockResolvedValue([]);

    render(await CompareViewsPage({
      params: Promise.resolve({ projectId: "project-1", comparisonId: "tvc_1" }),
    }));

    expect(screen.getByText("comparison loaded")).toBeInTheDocument();
    expect(mocks.getOverview).toHaveBeenCalledOnce();
    expect(mocks.getOverview).toHaveBeenCalledWith("project-1", "tvc_1");
    expect(mocks.renderClient).toHaveBeenCalledWith(expect.objectContaining({
      snapshot,
      comparisonId: "tvc_1",
      leftRuns: [runs[0]],
      rightRuns: [runs[1]],
    }));
  });

});
