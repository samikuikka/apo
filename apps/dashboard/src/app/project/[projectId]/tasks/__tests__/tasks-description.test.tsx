/**
 * The task's authored description on the Tasks page: the card shows it as a
 * muted single line under the title (nothing when absent), and search finds
 * a task by what it is for — the same surfaces the backend's grep matches.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentTasksClient } from "@/app/project/[projectId]/tasks/tasks-client";
import {
  getConnectedExecutorStatus,
  type AgentTaskSummary,
} from "@/lib/agent-task-api";
import type { ProjectTaskSource } from "@/lib/projects-api";

vi.mock("@/lib/agent-task-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-task-api")>(
    "@/lib/agent-task-api",
  );
  return {
    ...actual,
    createAgentTaskBatchRun: vi.fn(),
    getConnectedExecutorStatus: vi.fn().mockResolvedValue({ state: "ready" }),
    listArchivedAgentTasks: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("@/lib/agent-task-view-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-task-view-api")>(
    "@/lib/agent-task-view-api",
  );
  return {
    ...actual,
    fetchTaskViewConfigFacets: vi.fn().mockResolvedValue([]),
    fetchTaskViewStats: vi.fn().mockResolvedValue({}),
    fetchSavedViews: vi.fn().mockResolvedValue([]),
    createTaskViewComparison: vi.fn(),
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useParams: () => ({ projectId: "acme-evals" }),
}));

vi.mock("@/lib/project-router", () => ({
  useProjectId: () => "acme-evals",
  useIsDemo: () => false,
  DEFAULT_PROJECT: "example-service",
  DEMO_PROJECT: "demo",
}));

const taskSource = {
  source_type: "published",
  inventory_stale: false,
} as unknown as ProjectTaskSource;

function task(overrides: Partial<AgentTaskSummary> = {}): AgentTaskSummary {
  return {
    id: "documents/invoice-parsing",
    task_path: "tasks/documents/invoice-parsing",
    folder_path: "documents",
    display_name: "invoice-parsing",
    adapter_name: "claude-code",
    has_checks: false,
    tags: [],
    run_stats: null,
    ...overrides,
  };
}

describe("Tasks page — task descriptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConnectedExecutorStatus).mockResolvedValue({ state: "ready" });
  });

  it("shows the description as a muted line on the card", async () => {
    render(
      <AgentTasksClient
        tasks={[task({ description: "Extract structured data from an invoice." })]}
        error={null}
        taskSource={taskSource}
        isDemo={false}
      />,
    );

    expect(
      await screen.findByText("Extract structured data from an invoice."),
    ).toBeInTheDocument();
  });

  it("renders no description line when the task declares none", async () => {
    render(
      <AgentTasksClient tasks={[task()]} error={null} taskSource={taskSource} isDemo={false} />,
    );

    expect(await screen.findByText("invoice-parsing")).toBeInTheDocument();
    expect(screen.queryByText(/Extract structured data/)).not.toBeInTheDocument();
  });

  it("finds a task by its description in search", async () => {
    const user = userEvent.setup();
    render(
      <AgentTasksClient
        tasks={[task({ description: "Extract structured data from an invoice." })]}
        error={null}
        taskSource={taskSource}
        isDemo={false}
      />,
    );

    // "structured" appears in neither the task's name nor its path — only
    // the description carries it.
    await user.type(screen.getByTestId("tasks-search-input"), "structured");
    expect(screen.getByText("invoice-parsing")).toBeInTheDocument();

    await user.clear(screen.getByTestId("tasks-search-input"));
    await user.type(screen.getByTestId("tasks-search-input"), "no-such-word");
    expect(screen.queryByText("invoice-parsing")).not.toBeInTheDocument();
  });
});
