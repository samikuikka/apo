import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentTasksClient } from "@/app/project/[projectId]/tasks/tasks-client";
import {
  listArchivedAgentTasks,
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
    listArchivedAgentTasks: vi.fn().mockResolvedValue([]),
  };
});

// Evidence-view endpoints: the client fetches the model/effort palette on
// mount, the saved tabs, and view-scoped stats. Stub them so mount effects
// never hit the network and derived-tab state is deterministic. Saved-view
// persistence and the host palette are best-effort fire-and-forget in the
// client, so their stubs resolve instead of returning undefined.
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
    updateSavedView: vi.fn().mockResolvedValue(undefined),
    fetchTaskHostFacets: vi.fn().mockResolvedValue([]),
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

function task(overrides: Partial<AgentTaskSummary> = {}): AgentTaskSummary {
  return {
    id: "support/refund",
    task_path: "tasks/support/refund",
    folder_path: "support",
    display_name: "refund",
    adapter_name: "claude-code",
    has_checks: false,
    tags: [],
    run_stats: null,
    ...overrides,
  };
}

const taskSource = {
  source_type: "published",
  inventory_stale: false,
} as unknown as ProjectTaskSource;

/**
 * The tasks page's active-filter chips: one removable chip per filter value
 * (search, status, view cohort) plus a Clear-all sweep. Driven through the
 * rendered client, not the derivation, because the contract is what the user
 * can see and click.
 */
describe("AgentTasksClient — active filter chips", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderClient = () =>
    render(
      <AgentTasksClient
        tasks={[task()]}
        error={null}
        taskSource={taskSource}
        isDemo={false}
      />,
    );

  /** A saved view narrowed on every cohort dimension, plus its model facet. */
  const activateCohortView = async (user: ReturnType<typeof userEvent.setup>) => {
    const { fetchSavedViews, fetchTaskViewConfigFacets } = await import(
      "@/lib/agent-task-view-api"
    );
    vi.mocked(fetchSavedViews).mockResolvedValue([
      {
        id: "v-flash",
        label: "Flash view",
        model: "deepseek/deepseek-v4.1-flash",
        effort: "high",
        since: "7d",
        provider: "openrouter/flex",
      },
    ]);
    vi.mocked(fetchTaskViewConfigFacets).mockResolvedValue([
      {
        model: "deepseek/deepseek-v4.1-flash",
        count: 3,
        archived: false,
        efforts: [
          { effort: "high", count: 2 },
          { effort: "low", count: 1 },
        ],
      },
    ]);
    renderClient();
    // Anchor on the tab itself, not its close button ("Close Flash view tab").
    await user.click(await screen.findByRole("button", { name: /^Flash view/ }));
    // The tab carries the whole cohort, so every chip is owed at once.
    await screen.findByRole("button", {
      name: "Remove deepseek/deepseek-v4.1-flash filter",
    });
  };

  it("shows no chips row while nothing filters the list", async () => {
    renderClient();
    await screen.findByTestId("tasks-search-input");
    expect(screen.queryByText("Clear all")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Remove .* filter/)).not.toBeInTheDocument();
  });

  it("chips the search query and empties the input when the chip is removed", async () => {
    const user = userEvent.setup();
    renderClient();
    const input = screen.getByTestId("tasks-search-input");
    await user.type(input, "refund");
    expect(
      await screen.findByRole("button", { name: 'Remove "refund" filter' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: 'Remove "refund" filter' }));
    expect(input).toHaveValue("");
    expect(screen.queryByText('"refund"')).not.toBeInTheDocument();
  });

  it("chips each selected status and drops only that status when removed", async () => {
    const user = userEvent.setup();
    renderClient();
    await user.click(screen.getByRole("button", { name: "Status filter" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Passed/ }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Failed/ }));
    await user.keyboard("{Escape}");
    // The menu closes over the picks; two chips, one per status value.
    expect(
      await screen.findByRole("button", { name: "Remove Passed filter" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Failed filter" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove Passed filter" }));
    // Failed survives — removal is per value, not per dimension.
    expect(screen.queryByRole("button", { name: "Remove Passed filter" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Failed filter" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Status filter" }).textContent).toContain("Failed");
  });

  it("chips the active view's whole cohort and resets it on Clear all", async () => {
    const user = userEvent.setup();
    await activateCohortView(user);
    const { updateSavedView } = await import("@/lib/agent-task-view-api");
    expect(screen.getByRole("button", { name: "Remove openrouter/flex filter" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove high filter" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove 7 days filter" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.queryByLabelText(/Remove .* filter/)).not.toBeInTheDocument();
    // The tab's config line resets with the cohort — as does Main's, which
    // always read "everything"; hence the count, not a single match.
    expect(screen.getAllByText("everything")).toHaveLength(2);
    expect(vi.mocked(updateSavedView)).toHaveBeenCalledWith("acme-evals", "v-flash", {
      model: null,
      effort: null,
      since: null,
      provider: null,
    });
  });

  it("drops the model-scoped effort with the model chip, keeping other dimensions", async () => {
    const user = userEvent.setup();
    await activateCohortView(user);
    await user.click(
      screen.getByRole("button", { name: "Remove deepseek/deepseek-v4.1-flash filter" }),
    );
    // Effort only exists under a model, so it goes with the model.
    expect(screen.queryByRole("button", { name: "Remove high filter" })).not.toBeInTheDocument();
    // Host and date are independent dimensions and stay.
    expect(screen.getByRole("button", { name: "Remove openrouter/flex filter" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove 7 days filter" })).toBeInTheDocument();
  });

  it("drops the cohort chips while the archived view holds the list", async () => {
    const user = userEvent.setup();
    vi.mocked(listArchivedAgentTasks).mockResolvedValue([
      {
        task_id: "support/gone",
        display_name: "gone",
        folder_path: "support",
        task_path: "tasks/support/gone",
        removed_at: "2026-10-20T12:00:00Z",
        source_commit_sha: null,
        run_count: 2,
        run_stats: null,
      },
    ]);
    await activateCohortView(user);
    await user.click(screen.getByRole("button", { name: "Status filter" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Archived/ }));
    // The cohort narrows nothing while the archived membership holds the
    // list, so its chips must not claim to.
    expect(
      screen.queryByRole("button", { name: "Remove deepseek/deepseek-v4.1-flash filter" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove openrouter/flex filter" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove high filter" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove 7 days filter" })).not.toBeInTheDocument();
    // Back to the active suite: the cohort survived the detour and chips again.
    await user.click(screen.getByRole("button", { name: /back to the active suite/ }));
    expect(
      await screen.findByRole("button", { name: "Remove deepseek/deepseek-v4.1-flash filter" }),
    ).toBeInTheDocument();
  });
});
