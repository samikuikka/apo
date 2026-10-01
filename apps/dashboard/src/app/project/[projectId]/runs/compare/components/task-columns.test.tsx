import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { TaskColumns } from "./TaskColumns";
import type { AgentTaskRunSummary } from "@/lib/agent-task-api";

// ─── helpers ──────────────────────────────────────────────────────────────

let seq = 0;
function makeRun(
  taskPath: string,
  model: string,
  over: Partial<AgentTaskRunSummary> = {},
): AgentTaskRunSummary {
  seq += 1;
  return {
    id: `run-${seq}`,
    batch_run_id: "bch",
    task_id: taskPath,
    task_path: taskPath,
    adapter_name: null,
    status: "failed",
    pass_result: false,
    started_at: "2026-09-20T10:00:00Z",
    completed_at: "2026-09-20T10:00:20Z",
    trace_run_id: null,
    primary_model: model,
    task_source_commit_sha: null,
    error_message: null,
    total_cost: 1_000,
    total_tokens: 2_000,
    total_checks: 4,
    passed_checks: 2,
    failed_checks: 2,
    trigger: null,
    trace_persistence_status: "persisted",
    trace_error_message: null,
    error_category: null,
    run_configuration: { model, effort: null },
    ...over,
  };
}

function makePair() {
  const paths = ["flow-a/alpha", "flow-a/beta", "flow-b/gamma"];
  return {
    leftRuns: paths.map((p) => makeRun(p, "model-a", { total_cost: 500 })),
    rightRuns: paths.map((p) => makeRun(p, "model-b", { total_cost: 5_000 })),
  };
}

// ─── columns ──────────────────────────────────────────────────────────────

describe("TaskColumns", () => {
  it("renders one column per shared task, grouped under folder pills", () => {
    const { leftRuns, rightRuns } = makePair();
    render(<TaskColumns leftRuns={leftRuns} rightRuns={rightRuns} projectId="p1" />);
    // three task columns…
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.getByText("gamma")).toBeTruthy();
    // …under two folder pills
    expect(screen.getByText(/flow-a ▾/i)).toBeTruthy();
    expect(screen.getByText(/flow-b ▾/i)).toBeTruthy();
  });

  it("keeps the same columns when the metric changes — tasks without a value stay with a dash", async () => {
    const { leftRuns, rightRuns } = makePair();
    // gamma reports no cost on either side
    leftRuns[2] = { ...leftRuns[2], total_cost: null };
    rightRuns[2] = { ...rightRuns[2], total_cost: null };
    const { container } = render(<TaskColumns leftRuns={leftRuns} rightRuns={rightRuns} projectId="p1" />);

    const widthBefore = container.querySelector("svg")?.getAttribute("width");
    expect(screen.getByText("alpha")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "duration" }));
    const widthAfter = container.querySelector("svg")?.getAttribute("width");
    expect(widthAfter).toBe(widthBefore);
    expect(screen.getByText("gamma")).toBeTruthy();
  });

  it("pins the detail card on click — with links into both runs", () => {
    const { leftRuns, rightRuns } = makePair();
    const leftId = leftRuns[0].id;
    const rightId = rightRuns[0].id;
    render(<TaskColumns leftRuns={leftRuns} rightRuns={rightRuns} projectId="p1" />);

    // no card before a deliberate click
    expect(screen.queryByText("Open run A →")).toBeNull();

    fireEvent.click(screen.getByText("alpha"));
    expect(screen.getByText("Open run A →")).toBeTruthy();
    expect(screen.getByText("Open run B →")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open run A →" })).toHaveAttribute(
      "href",
      `/project/p1/runs/task/${leftId}`,
    );
    expect(screen.getByRole("link", { name: "Open run B →" })).toHaveAttribute(
      "href",
      `/project/p1/runs/task/${rightId}`,
    );
  });

  it("collapses a folder into a single aggregated column", () => {
    const { leftRuns, rightRuns } = makePair();
    render(<TaskColumns leftRuns={leftRuns} rightRuns={rightRuns} projectId="p1" />);

    fireEvent.click(screen.getByText(/flow-a ▾/i));
    // the folder folded into one aggregated column labeled with its size
    expect(screen.getByText(/flow-a \(2\)/i)).toBeTruthy();
    // the folder's tasks are folded away
    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.queryByText("beta")).toBeNull();
    // flow-b is untouched
    expect(screen.getByText("gamma")).toBeTruthy();
  });

  it("collapsed folder sums only tasks that report the metric", () => {
    const { leftRuns, rightRuns } = makePair();
    // beta: 500 + 500 A, 5000 + 5000 B; alpha reports no cost
    leftRuns[0] = { ...leftRuns[0], total_cost: null };
    rightRuns[0] = { ...rightRuns[0], total_cost: null };
    render(<TaskColumns leftRuns={leftRuns} rightRuns={rightRuns} projectId="p1" />);

    fireEvent.click(screen.getByText(/flow-a ▾/i));
    // the aggregate column exists with its task count…
    expect(screen.getByText(/flow-a \(2\)/i)).toBeTruthy();
    // …and draws real dots, not the no-data dash a fake-zero aggregate
    // (or an all-null one) would show — the null task contributed nothing
    // instead of pulling the sum to zero
    const dash = screen.queryByText("–");
    expect(dash).toBeNull();
  });
});
