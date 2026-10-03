/**
 * Tasks page refresh: the toolbar button re-runs the server page in place,
 * and a derived view refetches its scoped stats when fresh tasks arrive.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentTasksClient } from "@/app/project/[projectId]/tasks/tasks-client";
import type { AgentTaskSummary } from "@/lib/agent-task-api";
import type { ProjectTaskSource } from "@/lib/projects-api";

const refresh = vi.fn();

vi.mock("@/lib/agent-task-view-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/agent-task-view-api")
  >("@/lib/agent-task-view-api");
  return {
    ...actual,
    fetchTaskViewConfigFacets: vi.fn().mockResolvedValue([]),
    fetchSavedViews: vi.fn().mockResolvedValue([]),
    fetchTaskViewStats: vi.fn().mockResolvedValue({}),
  };
});

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/project/acme/tasks",
  useParams: () => ({ projectId: "acme" }),
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/project-router", () => ({
  useProjectId: () => "acme",
  useIsDemo: () => false,
  DEFAULT_PROJECT: "example-service",
  DEMO_PROJECT: "demo",
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

const makeTasks = (): AgentTaskSummary[] => [
  {
    id: "support/refund",
    task_path: "tasks/support/refund",
    folder_path: "support",
    display_name: "refund",
    adapter_name: "claude-code",
    has_checks: true,
    tags: [],
    run_stats: null,
  },
];

const taskSource = {
  source_type: "published",
  inventory_stale: false,
} as unknown as ProjectTaskSource;

describe("Tasks page refresh", () => {
  beforeEach(() => {
    refresh.mockClear();
  });

  it("refreshes the server page from the toolbar button", async () => {
    const user = userEvent.setup();
    render(
      <AgentTasksClient
        tasks={makeTasks()}
        error={null}
        taskSource={taskSource}
        isDemo={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Refresh tasks" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows the refresh button to read-only visitors", () => {
    render(
      <AgentTasksClient
        tasks={makeTasks()}
        error={null}
        taskSource={taskSource}
        isDemo={false}
        canRunTasks={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Refresh tasks" })).toBeInTheDocument();
  });

  it("refetches a derived view's stats when refreshed tasks arrive", async () => {
    const viewApi = await import("@/lib/agent-task-view-api");
    vi.mocked(viewApi.fetchSavedViews).mockResolvedValue([
      { id: "v1", label: "View 1", model: "claude-opus-5", effort: null, since: null, provider: null },
    ]);
    const stats = vi.mocked(viewApi.fetchTaskViewStats);
    stats.mockClear();

    const { rerender } = render(
      <AgentTasksClient
        tasks={makeTasks()}
        error={null}
        taskSource={taskSource}
        isDemo={false}
        initialViewId="v1"
      />,
    );
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(1));

    // router.refresh() hands the client a new tasks array from the server.
    rerender(
      <AgentTasksClient
        tasks={makeTasks()}
        error={null}
        taskSource={taskSource}
        isDemo={false}
        initialViewId="v1"
      />,
    );
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(2));
  });
});
