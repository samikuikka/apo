/**
 * Tasks → Runs: narrowing the task list narrows the Runs link with it.
 *
 * The complement to `dashboard-shell-run-cohort.test.tsx`, which covers the
 * link on a cohort published by hand. Here the cohort comes from the real
 * thing — picking a model in the evidence-view filter row.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DashboardShell } from "@/components/dashboard-shell";
import { AgentTasksClient } from "@/app/project/[projectId]/tasks/tasks-client";
import type { AgentTaskSummary } from "@/lib/agent-task-api";
import type { ProjectTaskSource } from "@/lib/projects-api";

// The shell reads the session to hide switcher chrome for anonymous demo
// visitors; these tests exercise cohort handoff, not sessions.
vi.mock("next-auth/react", () => ({
  useSession: () => ({ status: "authenticated", data: null }),
}));

vi.mock("@/lib/agent-task-view-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/agent-task-view-api")
  >("@/lib/agent-task-view-api");
  return {
    ...actual,
    fetchTaskViewConfigFacets: vi.fn().mockResolvedValue([
      {
        model: "claude-opus-5",
        count: 4,
        efforts: [
          { effort: "high", count: 2 },
          { effort: "low", count: 2 },
        ],
        archived: false,
      },
    ]),
    fetchSavedViews: vi.fn().mockResolvedValue([]),
    fetchTaskViewStats: vi.fn().mockResolvedValue({}),
  };
});

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/project/acme/tasks",
  useParams: () => ({ projectId: "acme" }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/project-router", () => ({
  useProjectId: () => "acme",
  useIsDemo: () => false,
  DEFAULT_PROJECT: "example-service",
  DEMO_PROJECT: "demo",
}));

vi.mock("@/components/project-switcher", () => ({
  ProjectSwitcher: () => <div data-testid="project-switcher" />,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

const tasks: AgentTaskSummary[] = [
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

const runsHref = () =>
  screen.getByRole("link", { name: "Runs" }).getAttribute("href");

const taskHref = () =>
  screen.getByRole("link", { name: /refund/ }).getAttribute("href");

describe("Tasks page cohort handoff", () => {
  it("points at the unfiltered run list while Main is active", () => {
    render(
      <DashboardShell projectId="acme">
        <AgentTasksClient
          tasks={tasks}
          error={null}
          taskSource={taskSource}
          isDemo={false}
        />
      </DashboardShell>,
    );
    expect(runsHref()).toBe("/project/acme/runs");
    expect(taskHref()).toBe("/project/acme/tasks/support/refund");
  });

  it("narrows the Runs link to the model the view filters on", async () => {
    const user = userEvent.setup();
    render(
      <DashboardShell projectId="acme">
        <AgentTasksClient
          tasks={tasks}
          error={null}
          taskSource={taskSource}
          isDemo={false}
        />
      </DashboardShell>,
    );

    await user.click(screen.getByRole("button", { name: "Model filter" }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: /claude-opus-5/ }),
    );

    await waitFor(() =>
      expect(runsHref()).toBe("/project/acme/runs?model=claude-opus-5"),
    );
  });

  it("carries the view cohort into the task detail link", async () => {
    const user = userEvent.setup();
    render(
      <DashboardShell projectId="acme">
        <AgentTasksClient
          tasks={tasks}
          error={null}
          taskSource={taskSource}
          isDemo={false}
        />
      </DashboardShell>,
    );

    await user.click(screen.getByRole("button", { name: "Model filter" }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: /claude-opus-5/ }),
    );

    // The card's stats are scoped to the view; the detail page's run history
    // must land on the same cohort, not all-history.
    await waitFor(() =>
      expect(taskHref()).toBe(
        "/project/acme/tasks/support/refund?model=claude-opus-5",
      ),
    );
  });

  it("carries the saved-view identity into the task detail link", async () => {
    const viewApi = await import("@/lib/agent-task-view-api");
    vi.mocked(viewApi.fetchSavedViews).mockResolvedValue([
      { id: "v1", label: "View 1", model: "claude-opus-5", effort: null, since: null, provider: null },
    ]);
    const user = userEvent.setup();
    render(
      <DashboardShell projectId="acme">
        <AgentTasksClient
          tasks={tasks}
          error={null}
          taskSource={taskSource}
          isDemo={false}
        />
      </DashboardShell>,
    );

    // Anchored so the tab button ("View 1 …") is matched, not its inline
    // "Close View 1 tab" affordance.
    await user.click(await screen.findByRole("button", { name: /^View 1/ }));

    // The detail page uses ?view= to name the scope's origin and to restore
    // the tab on the way back — so it must travel with the cohort.
    await waitFor(() =>
      expect(taskHref()).toBe(
        "/project/acme/tasks/support/refund?model=claude-opus-5&view=v1",
      ),
    );
  });

  it("restores the saved tab on mount from initialViewId", async () => {
    const viewApi = await import("@/lib/agent-task-view-api");
    vi.mocked(viewApi.fetchSavedViews).mockResolvedValue([
      { id: "v1", label: "View 1", model: "claude-opus-5", effort: null, since: null, provider: null },
    ]);
    render(
      <DashboardShell projectId="acme">
        <AgentTasksClient
          tasks={tasks}
          error={null}
          taskSource={taskSource}
          isDemo={false}
          initialViewId="v1"
        />
      </DashboardShell>,
    );

    // No clicks: arriving via <- Tasks with ?view=v1 re-selects the tab, so
    // cards immediately carry that view's cohort and identity.
    await waitFor(() =>
      expect(taskHref()).toBe(
        "/project/acme/tasks/support/refund?model=claude-opus-5&view=v1",
      ),
    );
  });
});
