import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock the heavy FlowSection so the test stays isolated to the view-comparison
// header + summary + single-task enforcement.
const onToggleExpand = vi.fn();
vi.mock("../../runs/compare/components/FlowSection", () => ({
  FlowSection: ({ folder, tasks, expanded, onToggleExpand }: {
    folder: string;
    tasks: { taskId: string }[];
    expanded: Set<string>;
    onToggleExpand: (id: string) => void;
  }) => (
    <div data-testid={`flow-${folder}`}>
      {tasks.map((t) => (
        <button
          key={t.taskId}
          type="button"
          data-testid={`toggle-${t.taskId}`}
          aria-expanded={expanded.has(t.taskId)}
          onClick={() => onToggleExpand(t.taskId)}
        >
          {t.taskId}
        </button>
      ))}
    </div>
  ),
}));

const setActiveTaskId = vi.fn();
vi.mock("@/hooks/use-url-state", () => ({
  useUrlParam: vi.fn(() => ["", setActiveTaskId]),
}));

vi.mock("@/lib/project-router", () => ({
  useProjectId: () => "acme-evals",
  useIsDemo: () => false,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { CompareViewsClient } from "@/app/project/[projectId]/compare-views/[comparisonId]/compare-views-client";
import type { AgentTaskRunSummary, AgentTaskSummary } from "@/lib/agent-task-api";
import type { TaskViewComparisonSnapshot } from "@/lib/agent-task-view-api";

function task(id: string, name: string, folder: string): AgentTaskSummary {
  return {
    id, task_path: `tasks/${id}`, folder_path: folder, display_name: name,
    adapter_name: "claude-code", has_checks: false, tags: [], run_stats: null,
  };
}

function run(id: string, taskId: string, status: string, passResult: boolean, checks = 5, passed = 3): AgentTaskRunSummary {
  return {
    id, batch_run_id: "b1", task_id: taskId, task_path: `tasks/${taskId}`,
    sequence_index: 0, adapter_name: null, status, pass_result: passResult,
    started_at: "2026-08-07T00:00:00Z", completed_at: "2026-08-07T00:00:01Z",
    trace_run_id: null, error_message: null, trace_persistence_status: "pending",
    trace_error_message: null, checks_json: "null", total_checks: checks,
    passed_checks: passed, failed_checks: checks - passed, transcript_json: "null",
    deliverables_json: "null", total_cost: 100, total_tokens: 0, configured_model: null,
    configured_effort: null, task_inventory_id: null, task_source_commit_sha: null,
    unpriced_call_count: 0,
  } as unknown as AgentTaskRunSummary;
}

const snapshot: TaskViewComparisonSnapshot = {
  id: "tvc_test", project_id: "acme-evals",
  view_a_config: { model: "claude-opus-4.1", effort: null, since: null },
  view_b_config: { model: "deepseek-v3", effort: null, since: null },
  task_ids: ["evals/alpha", "evals/beta"],
  resolved: [
    { task_id: "evals/alpha", a_run_id: "ra", b_run_id: "rb", a_status: "passed", b_status: "failed", state: "aligned" },
    { task_id: "evals/beta", a_run_id: "rc", b_run_id: "rd", a_status: "passed", b_status: "passed", state: "different_definition" },
  ],
  coverage: { both_run: 2, aligned: 1, scope: 2 },
  created_at: "2026-08-07T00:00:00Z", created_by: null,
};

const tasks = [task("evals/alpha", "Alpha", "evals"), task("evals/beta", "Beta", "evals")];
const leftRuns = [run("ra", "evals/alpha", "passed", true), run("rc", "evals/beta", "passed", true)];
const rightRuns = [run("rb", "evals/alpha", "failed", false, 5, 0), run("rd", "evals/beta", "passed", true)];

describe("CompareViewsClient", () => {
  it("renders both view configs in the header and the differs summary", () => {
    render(
      <CompareViewsClient
        projectId="acme-evals"
        comparisonId="tvc_test"
        snapshot={snapshot}
        tasks={tasks}
        leftRuns={leftRuns}
        rightRuns={rightRuns}
      />,
    );
    expect(screen.getByText("claude-opus-4.1")).toBeInTheDocument();
    expect(screen.getByText("deepseek-v3")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText(/tasks differ/)).toBeInTheDocument();
    expect(screen.getByText("evals/alpha")).toBeInTheDocument();
    expect(screen.getByText("evals/beta")).toBeInTheDocument();
  });
});

describe("CompareViewsClient single-task expansion", () => {
  beforeEach(() => {
    setActiveTaskId.mockReset();
    onToggleExpand.mockReset();
    useUrlParamMock.mockReturnValue(["", setActiveTaskId]);
  });

  it("expanding a task sets the URL param to that task", () => {
    render(
      <CompareViewsClient
        projectId="acme-evals"
        comparisonId="tvc_test"
        snapshot={snapshot}
        tasks={tasks}
        leftRuns={leftRuns}
        rightRuns={rightRuns}
      />,
    );

    fireEvent.click(screen.getByTestId("toggle-evals/alpha"));
    expect(setActiveTaskId).toHaveBeenCalledWith("evals/alpha");
  });

  it("expanding the same task again clears it", () => {
    // Simulate the task already being active.
    vi.mocked(useUrlParamMock).mockReturnValue(["evals/alpha", setActiveTaskId]);

    render(
      <CompareViewsClient
        projectId="acme-evals"
        comparisonId="tvc_test"
        snapshot={snapshot}
        tasks={tasks}
        leftRuns={leftRuns}
        rightRuns={rightRuns}
      />,
    );

    fireEvent.click(screen.getByTestId("toggle-evals/alpha"));
    expect(setActiveTaskId).toHaveBeenCalledWith(null);
  });

  it("expanding task B while A is active replaces A (single-task)", () => {
    vi.mocked(useUrlParamMock).mockReturnValue(["evals/alpha", setActiveTaskId]);

    render(
      <CompareViewsClient
        projectId="acme-evals"
        comparisonId="tvc_test"
        snapshot={snapshot}
        tasks={tasks}
        leftRuns={leftRuns}
        rightRuns={rightRuns}
      />,
    );

    fireEvent.click(screen.getByTestId("toggle-evals/beta"));
    expect(setActiveTaskId).toHaveBeenCalledWith("evals/beta");
  });

  it("equal-result tasks remain visible and expandable", () => {
    render(
      <CompareViewsClient
        projectId="acme-evals"
        comparisonId="tvc_test"
        snapshot={snapshot}
        tasks={tasks}
        leftRuns={leftRuns}
        rightRuns={rightRuns}
      />,
    );

    // beta is pass/pass (equal) but must still be visible and expandable:
    // it renders as a real row, starts collapsed, and its toggle activates it.
    const betaRow = screen.getByRole("button", { name: "evals/beta" });
    expect(betaRow).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(betaRow);
    expect(setActiveTaskId).toHaveBeenCalledWith("evals/beta");
  });
});

// Import after mocks so the mock takes effect.
import { useUrlParam } from "@/hooks/use-url-state";
const useUrlParamMock = vi.mocked(useUrlParam);
