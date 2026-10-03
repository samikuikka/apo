import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentTasksClient } from "@/app/project/[projectId]/tasks/tasks-client";
import {
  createAgentTaskBatchRun,
  type AgentTaskSummary,
} from "@/lib/agent-task-api";
import type { ProjectTaskSource } from "@/lib/projects-api";

vi.mock("@/lib/agent-task-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-task-api")>(
    "@/lib/agent-task-api",
  );
  return { ...actual, createAgentTaskBatchRun: vi.fn() };
});

// Evidence-view endpoints: the client fetches the model/effort
// palette on mount and view-scoped stats on tab switch. Stub them so the mount
// effect doesn't hit the network and so derived-tab stats are deterministic.
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

const originalLocation = window.location;

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

describe("AgentTasksClient — native source-owned Run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `window.location.href =` assignment is what the client uses to navigate
    // after a successful create. jsdom throws on assignment without a setter.
    Object.defineProperty(window, "location", {
      value: { href: originalLocation.href },
      writable: true,
    });
  });

  it("never disables Run for a non-ready environment status", async () => {
    const user = userEvent.setup();
    render(
      <AgentTasksClient
        tasks={[task()]}
        error={null}
        taskSource={taskSource}
        isDemo={false}
      />,
    );
    // Select the task first (Run is only gated on selection + permissions,
    // never on environment state). First checkbox is the header select-all.
    await user.click(screen.getAllByRole("checkbox")[0]);

    const runButtons = screen.getAllByRole("button", { name: /Run/i });
    expect(runButtons.every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
    // No Pool selector copy surfaces.
    expect(screen.queryByText(/Choose where this run should execute/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/executor pool/i)).not.toBeInTheDocument();
  });

  it("sends only the fields the narrowed create API accepts on Run", async () => {
    const user = userEvent.setup();
    vi.mocked(createAgentTaskBatchRun).mockResolvedValueOnce({
      id: "batch-1",
    } as Awaited<ReturnType<typeof createAgentTaskBatchRun>>);
    const tasks = [task({ id: "support/refund" }), task({ id: "support/cancel", display_name: "cancel" })];
    render(
      <AgentTasksClient
        tasks={tasks}
        error={null}
        taskSource={taskSource}
        isDemo={false}
      />,
    );

    // First checkbox is the header select-all; selecting it picks every task.
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);

    const runButtons = screen.getAllByRole("button", { name: /Run/i });
    await user.click(runButtons[0]);

    await waitFor(() => {
      expect(createAgentTaskBatchRun).toHaveBeenCalledTimes(1);
    });
    const call = vi.mocked(createAgentTaskBatchRun).mock.calls[0][0];
    expect(call.task_ids).toEqual(expect.arrayContaining(["support/refund", "support/cancel"]));
    // The backend model forbids extra fields, so any key beyond these 422s the
    // whole request — `selection_type` and `execution_target` are derived
    // server-side and must not be sent.
    expect(Object.keys(call).sort()).toEqual(["project", "run_metadata", "task_ids"]);
  });
});

describe("AgentTasksClient — evidence views", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the permanent Main tab and the Model filter header", async () => {
    render(
      <AgentTasksClient
        tasks={[task()]}
        error={null}
        taskSource={taskSource}
        isDemo={false}
      />,
    );
    // The Main tab is always present (permanent) and shows the "everything"
    // config readout; the Model filter is part of the unified header.
    expect(screen.getByText("Main")).toBeInTheDocument();
    expect(screen.getByText("everything")).toBeInTheDocument();
    // The Model filter label renders as part of the unified header (CSS
    // uppercases it visually; the DOM text is the capitalized form).
    expect(screen.getByText("Model")).toBeInTheDocument();
    // The palette fetch fires once on mount (drives the Model dropdown options).
    const { fetchTaskViewConfigFacets } = await import("@/lib/agent-task-view-api");
    await waitFor(() => {
      expect(fetchTaskViewConfigFacets).toHaveBeenCalledWith("acme-evals");
    });
  });

  it("exposes Compare on the selection action bar once tasks are checked", async () => {
    const user = userEvent.setup();
    render(
      <AgentTasksClient
        tasks={[task(), task({ id: "support/cancel", display_name: "cancel" })]}
        error={null}
        taskSource={taskSource}
        isDemo={false}
      />,
    );
    // Header select-all picks every task, which surfaces the bar.
    await user.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByRole("button", { name: /Compare/i })).toBeInTheDocument();
  });
});

describe("AgentTasksClient — select all", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const multiFolderTasks = [
    task({ id: "support/refund" }),
    task({ id: "support/cancel", display_name: "cancel" }),
    task({ id: "billing/invoice", folder_path: "billing", display_name: "invoice" }),
  ];

  it("header checkbox selects tasks across every folder at once", async () => {
    const user = userEvent.setup();
    render(
      <AgentTasksClient
        tasks={multiFolderTasks}
        error={null}
        taskSource={taskSource}
        isDemo={false}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Select all tasks" }));

    // Every folder reports its selection and the toolbar Run label tracks it.
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByText("Run 3 tasks")).toBeInTheDocument();
  });

  it("shows indeterminate when only part of the visible tasks are selected", async () => {
    const user = userEvent.setup();
    render(
      <AgentTasksClient
        tasks={multiFolderTasks}
        error={null}
        taskSource={taskSource}
        isDemo={false}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Select refund" }));

    expect(screen.getByRole("checkbox", { name: "Select all tasks" })).toHaveAttribute(
      "data-state",
      "indeterminate",
    );
  });

  it("header checkbox clears the whole selection when everything is selected", async () => {
    const user = userEvent.setup();
    render(
      <AgentTasksClient
        tasks={multiFolderTasks}
        error={null}
        taskSource={taskSource}
        isDemo={false}
      />,
    );

    const selectAll = screen.getByRole("checkbox", { name: "Select all tasks" });
    await user.click(selectAll);
    await user.click(selectAll);

    expect(screen.queryByRole("button", { name: /Compare/i })).not.toBeInTheDocument();
    expect(screen.getByText("Run selected")).toBeInTheDocument();
  });

  it("header checkbox only selects tasks visible under the current filter", async () => {
    const user = userEvent.setup();
    render(
      <AgentTasksClient
        tasks={multiFolderTasks}
        error={null}
        taskSource={taskSource}
        isDemo={false}
      />,
    );

    await user.type(screen.getByPlaceholderText("Filter tasks..."), "invoice");
    await user.click(screen.getByRole("checkbox", { name: "Select all tasks" }));

    expect(screen.getByText("Run 1 task")).toBeInTheDocument();
  });
});

describe("AgentTasksClient — active view tab in the URL", () => {
  // A derived saved tab: model is pinned, so the tab is "derived" and shows
  // the scoped-stats chip when active.
  const savedView = {
    id: "v-91",
    label: "Opus only",
    model: "gpt-5.2",
    effort: null,
    since: null,
    provider: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // The native-Run describe above replaces window.location with a bare
    // { href } object; the URL-sync assertions need the real jsdom location
    // (history.replaceState writes through it). Restore it and start clean.
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
    });
    window.history.replaceState(null, "", "/");
  });

  it("writes ?view=<id> when a saved tab is selected and clears it back on Main", async () => {
    const user = userEvent.setup();
    const { fetchSavedViews } = await import("@/lib/agent-task-view-api");
    vi.mocked(fetchSavedViews).mockResolvedValue([savedView]);
    render(
      <AgentTasksClient
        tasks={[task()]}
        error={null}
        taskSource={taskSource}
        isDemo={false}
      />,
    );

    // Anchor on the tab itself ("Opus only gpt-5.2"), not its close button
    // ("Close Opus only tab").
    await user.click(await screen.findByRole("button", { name: /^Opus only/ }));
    expect(new URLSearchParams(window.location.search).get("view")).toBe("v-91");

    await user.click(screen.getByRole("button", { name: /^Main/ }));
    expect(new URLSearchParams(window.location.search).get("view")).toBeNull();
  });

  it("keeps ?view= for the whole visit when arriving with the saved tab selected", async () => {
    const { fetchSavedViews } = await import("@/lib/agent-task-view-api");
    vi.mocked(fetchSavedViews).mockResolvedValue([savedView]);
    window.history.replaceState(null, "", "/?view=v-91");
    render(
      <AgentTasksClient
        tasks={[task()]}
        error={null}
        taskSource={taskSource}
        isDemo={false}
        initialViewId="v-91"
      />,
    );

    // The saved tab is active (derived view → scoped chip) and the URL param
    // survives the mount effects instead of being dropped.
    await screen.findByText("scoped to this view");
    expect(new URLSearchParams(window.location.search).get("view")).toBe("v-91");
  });

  it("falls back to Main and heals the URL when ?view= names a deleted view", async () => {
    const { fetchSavedViews } = await import("@/lib/agent-task-view-api");
    vi.mocked(fetchSavedViews).mockResolvedValue([savedView]);
    window.history.replaceState(null, "", "/?view=v-gone");
    render(
      <AgentTasksClient
        tasks={[task()]}
        error={null}
        taskSource={taskSource}
        isDemo={false}
        initialViewId="v-gone"
      />,
    );

    // Saved views load, v-gone is not among them → Main takes over and the
    // stale param is removed so a reload lands on Main, not a ghost tab.
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("view")).toBeNull();
    });
    expect(screen.queryByText("scoped to this view")).not.toBeInTheDocument();
  });
});
