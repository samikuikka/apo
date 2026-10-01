/**
 * The receiving end of the Tasks → Runs cohort handoff.
 *
 * Filters can now arrive with the navigation rather than being typed here, so
 * every one of them has to be visible and clearable on arrival — an applied
 * filter with no control to undo it reads as an empty project.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RunsClient } from "@/app/project/[projectId]/runs/runs-client";
import type { ModelFacetOption } from "@/lib/agent-task-api";

const replace = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => "/project/acme/runs",
  useRouter: () => ({ replace, refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => searchParams,
  useParams: () => ({ projectId: "acme" }),
}));

vi.mock("@/lib/project-router", () => ({
  useProjectId: () => "acme",
  useIsDemo: () => false,
  DEFAULT_PROJECT: "example-service",
  DEMO_PROJECT: "demo",
}));

const rowProps = vi.fn();
vi.mock("@/app/project/[projectId]/runs/components/RunsRow", () => ({
  RunsRow: (props: { batch: { id: string } }) => {
    rowProps(props);
    return (
      <tr>
        <td>{props.batch.id}</td>
      </tr>
    );
  },
}));

const autoRefreshProps = vi.fn();
vi.mock("@/components/agent-task-execution/runs-list-auto-refresh", () => ({
  RunsListAutoRefresh: (props: unknown) => {
    autoRefreshProps(props);
    return null;
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

const facets: ModelFacetOption[] = [
  {
    model: "claude-opus-5",
    count: 3,
    efforts: [{ effort: "high", count: 3 }],
    archived: false,
  },
];

function renderRuns(query: string, modelFacets: ModelFacetOption[] = facets) {
  searchParams = new URLSearchParams(query);
  return render(
    <RunsClient
      batchRuns={[]}
      error={null}
      taskSource={{ source_type: "published" } as never}
      totalCount={0}
      page={0}
      pageSize={20}
      totalPages={0}
      modelFacets={modelFacets}
      providerFacets={[]}
      canDeleteRuns={false}
    />,
  );
}

describe("Runs page live refresh", () => {
  beforeEach(() => {
    autoRefreshProps.mockClear();
  });

  it("watches for newly started runs on the first page", () => {
    renderRuns("");
    expect(autoRefreshProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ project: "acme", batchRuns: [], watchForNewRuns: true }),
    );
  });

  it("hands the listed runs to the live refresh", () => {
    const listed = [
      {
        id: "bch_1",
        project: "acme",
        selection_type: "all",
        selection_query: null,
        status: "running",
        total_tasks: 1,
        passed_tasks: 0,
        failed_tasks: 0,
        errored_tasks: 0,
        total_checks: 0,
        passed_checks: 0,
        created_at: "2026-09-14T00:00:00Z",
        started_at: "2026-09-14T00:00:00Z",
        completed_at: null,
        trigger: null,
        total_cost: null,
        total_tokens: null,
        configuration: { state: "unknown", configurations: [], reported_task_runs: 0, total_task_runs: 1 },
      },
    ] as never[];
    searchParams = new URLSearchParams("");
    render(
      <RunsClient
        batchRuns={listed}
        error={null}
        taskSource={{ source_type: "published" } as never}
        totalCount={1}
        page={0}
        pageSize={20}
        totalPages={1}
        modelFacets={facets}
        providerFacets={[]}
        canDeleteRuns={false}
      />,
    );
    expect(autoRefreshProps).toHaveBeenCalledWith(expect.objectContaining({ batchRuns: listed }));

    // Task starts reported by the live refresh reach the row as a tick.
    expect(rowProps).toHaveBeenLastCalledWith(expect.objectContaining({ taskStartTick: 0 }));
    const { onTasksStarted } = autoRefreshProps.mock.calls.at(-1)![0] as {
      onTasksStarted: (ids: string[]) => void;
    };
    act(() => onTasksStarted(["bch_1"]));
    expect(rowProps).toHaveBeenLastCalledWith(expect.objectContaining({ taskStartTick: 1 }));
    act(() => onTasksStarted(["bch_other", "bch_1"]));
    expect(rowProps).toHaveBeenLastCalledWith(expect.objectContaining({ taskStartTick: 2 }));
  });

  it("does not watch for new runs on a later page, where they never land", () => {
    searchParams = new URLSearchParams("page=2");
    render(
      <RunsClient
        batchRuns={[]}
        error={null}
        taskSource={{ source_type: "published" } as never}
        totalCount={60}
        page={2}
        pageSize={20}
        totalPages={3}
        modelFacets={facets}
        providerFacets={[]}
        canDeleteRuns={false}
      />,
    );
    expect(autoRefreshProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ watchForNewRuns: false }),
    );
  });
});

describe("Runs page with filters carried in", () => {
  beforeEach(() => {
    replace.mockClear();
  });

  it("shows no clear action when nothing is filtered", () => {
    renderRuns("");
    expect(screen.queryByTestId("runs-clear-filters")).toBeNull();
  });

  it("clears every filter dimension in one click", async () => {
    const user = userEvent.setup();
    renderRuns("model=claude-opus-5&effort=high&since=5d&q=nightly&status=failed");

    await user.click(screen.getByTestId("runs-clear-filters"));

    expect(replace).toHaveBeenCalledWith("/project/acme/runs", {
      scroll: false,
    });
  });

  it("says a project has no runs only when nothing is filtered", () => {
    renderRuns("");
    expect(screen.getByText(/No runs yet/)).toBeInTheDocument();
  });

  it("says the filters matched nothing rather than that the project is empty", async () => {
    // The count the page receives is the filtered one, so an empty result used
    // to read as "No runs yet" — the wrong story now that a filter can arrive
    // with the navigation.
    const user = userEvent.setup();
    renderRuns("model=claude-opus-5&since=5d");
    const emptyState = screen.getByText(/No runs match these filters/);
    expect(emptyState).toBeInTheDocument();

    await user.click(within(emptyState).getByRole("button", { name: "Clear Filters" }));
    expect(replace).toHaveBeenCalledWith("/project/acme/runs", {
      scroll: false,
    });
  });

  it("displays a date window that is not one of its own presets", () => {
    renderRuns("since=5d");
    expect(screen.getByRole("combobox", { name: "Date filter" })).toHaveTextContent("5 days");
  });

  it("shows the effort control for a carried effort with a single tier", () => {
    // The facets hold one tier, which normally hides the control — but the URL
    // selects an effort, so it has to stay on screen to be undone.
    renderRuns("model=claude-opus-5&effort=high");
    expect(screen.getByRole("combobox", { name: "Effort filter" })).toHaveTextContent("high");
  });

  it("shows the effort control even when the facets know nothing of it", () => {
    renderRuns("model=claude-opus-5&effort=medium", []);
    expect(screen.getByRole("combobox", { name: "Effort filter" })).toHaveTextContent("medium");
  });
});
