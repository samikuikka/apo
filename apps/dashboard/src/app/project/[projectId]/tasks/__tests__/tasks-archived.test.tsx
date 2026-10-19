import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentTasksClient } from "@/app/project/[projectId]/tasks/tasks-client";
import {
  getConnectedExecutorStatus,
  listArchivedAgentTasks,
  type AgentTaskSummary,
  type ArchivedAgentTask,
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

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const taskSource = {
  source_type: "published",
  inventory_stale: false,
} as unknown as ProjectTaskSource;

function activeTask(): AgentTaskSummary {
  return {
    id: "support/refund",
    task_path: "tasks/support/refund",
    folder_path: "support",
    display_name: "refund",
    adapter_name: "claude-code",
    has_checks: false,
    tags: [],
    run_stats: null,
  };
}

function archivedEntry(overrides: Partial<ArchivedAgentTask> = {}): ArchivedAgentTask {
  return {
    task_id: "ai-sdk-agent/serving-integrity",
    display_name: "serving-integrity",
    folder_path: "ai-sdk-agent",
    task_path: "ai-sdk-agent/serving-integrity",
    removed_at: "2026-10-15T12:00:00Z",
    source_commit_sha: "2d81b43d9aa",
    run_count: 43,
    run_stats: {
      total_runs: 43,
      not_started_runs: 0,
      passed_runs: 31,
      failed_runs: 12,
      errored_runs: 0,
      pass_rate: 0.72,
      avg_duration_ms: 102000,
      last_run_at: "2026-10-14T14:02:00Z",
      last_run_status: "passed",
      last_run_passed: true,
      last_run_no_verdict: false,
      total_checks: 8,
      checks_pass_rate: 0.92,
      errored_checks: 0,
      avg_cost: 30,
    },
    ...overrides,
  };
}

async function openStatusMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Status filter" }));
}

describe("Tasks page — archived (task removal archiving)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConnectedExecutorStatus).mockResolvedValue({ state: "ready" });
  });

  it("shows no archived entry when nothing is archived", async () => {
    vi.mocked(listArchivedAgentTasks).mockResolvedValue([]);
    const user = userEvent.setup();
    render(
      <AgentTasksClient tasks={[activeTask()]} error={null} taskSource={taskSource} isDemo={false} />,
    );

    await openStatusMenu(user);

    expect(screen.queryByText("Not in the suite")).not.toBeInTheDocument();
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();
    // Close the menu: Radix's scroll-lock otherwise leaks into the next
    // test and swallows its clicks (body pointer-events: none).
    await user.keyboard("{Escape}");
  });

  it("lists the archived count and swaps the list on click, with a way back", async () => {
    const entry = archivedEntry();
    vi.mocked(listArchivedAgentTasks).mockResolvedValue([entry]);
    const user = userEvent.setup();
    render(
      <AgentTasksClient tasks={[activeTask()]} error={null} taskSource={taskSource} isDemo={false} />,
    );

    await openStatusMenu(user);
    expect(await screen.findByText("Not in the suite")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Archived/ }));

    // The banner names the membership and offers the way back.
    expect(await screen.findByText(/1 task not in the active suite/)).toBeInTheDocument();
    // The removed task renders with the same card anatomy: name, Removed
    // status label, and the removal note with date + publish sha.
    expect(screen.getByText("serving-integrity")).toBeInTheDocument();
    expect(screen.getByText("Removed")).toBeInTheDocument();
    expect(screen.getByText(/Removed 2026-10-15 · publish 2d81b43/)).toBeInTheDocument();

    await user.click(screen.getByText(/back to the active suite/));
    expect(screen.getByText("refund")).toBeInTheDocument();
    expect(screen.queryByText(/not in the active suite/)).not.toBeInTheDocument();
  });

  it("suggests the archived match when a search finds nothing active", async () => {
    vi.mocked(listArchivedAgentTasks).mockResolvedValue([archivedEntry()]);
    const user = userEvent.setup();
    render(
      <AgentTasksClient tasks={[activeTask()]} error={null} taskSource={taskSource} isDemo={false} />,
    );

    await user.type(screen.getByTestId("tasks-search-input"), "serving");

    expect(await screen.findByText(/1 archived match/)).toBeInTheDocument();
    expect(screen.getByText("serving-integrity")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Show the archived view/ }));
    expect(await screen.findByText(/not in the active suite/)).toBeInTheDocument();
    // The query rides along: only the removed task shows, the active one doesn't.
    expect(screen.queryByText("refund")).not.toBeInTheDocument();
  });

  it("keeps the page unchanged for demo projects (no archived fetch)", async () => {
    const user = userEvent.setup();
    render(
      <AgentTasksClient tasks={[activeTask()]} error={null} taskSource={taskSource} isDemo={true} />,
    );

    await openStatusMenu(user);
    expect(screen.queryByText("Not in the suite")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(listArchivedAgentTasks).not.toHaveBeenCalled();
    });
  });
});
