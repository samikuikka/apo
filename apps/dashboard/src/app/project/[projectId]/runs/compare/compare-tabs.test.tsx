import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import type { AgentTaskBatchRunDetail, AgentTaskRunSummary } from "@/lib/agent-task-api";

// Tabs navigate via router.replace — stub the router, capture the target.
const searchParamsMock = vi.hoisted(() => ({ current: new URLSearchParams("") }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParamsMock.current,
}));

import { CompareClient } from "./compare-client";

// ─── helpers ──────────────────────────────────────────────────────────────

function makeRun(id: string, path: string, over: Partial<AgentTaskRunSummary> = {}): AgentTaskRunSummary {
  return {
    id,
    batch_run_id: `bch-${id}`,
    task_id: path,
    task_path: path,
    adapter_name: null,
    status: "failed",
    pass_result: false,
    started_at: "2026-09-20T10:00:00Z",
    completed_at: "2026-09-20T10:00:20Z",
    trace_run_id: null,
    primary_model: "model-x",
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
    run_configuration: null,
    ...over,
  };
}

function makeBatch(id: string, runs: AgentTaskRunSummary[]): AgentTaskBatchRunDetail {
  return {
    id,
    project: "p1",
    selection_type: "tasks",
    selection_query: { task_paths: ["suite"] },
    task_root: null,
    grep: null,
    environment: "default",
    status: "completed",
    total_tasks: runs.length,
    passed_tasks: 0,
    failed_tasks: runs.length,
    errored_tasks: 0,
    total_checks: runs.length * 4,
    passed_checks: runs.length * 2,
    created_at: "2026-09-20T10:00:00Z",
    started_at: "2026-09-20T10:00:00Z",
    completed_at: "2026-09-20T10:05:00Z",
    trace_persistence_status: "persisted",
    trace_error_message: null,
    task_source_type: null,
    task_source_ref: null,
    task_source_commit_sha: null,
    task_source_subpath: null,
    execution_target_json: null,
    cancelled_tasks: 0,
    requested_by_user_id: null,
    total_cost: 1_000 * runs.length,
    total_tokens: 2_000 * runs.length,
    configuration: { state: "uniform", configurations: [{ model: "model-x", effort: null }], reported_task_runs: runs.length, total_task_runs: runs.length },
    trigger: null,
    task_runs: runs,
  } as unknown as AgentTaskBatchRunDetail;
}

function setup(tab: "tasks" | "summary" = "tasks") {
  searchParamsMock.current = new URLSearchParams(tab === "summary" ? "?tab=summary" : "");
  const left = [makeRun("a1", "flow/task-one"), makeRun("a2", "flow/task-two")];
  const right = [
    makeRun("b1", "flow/task-one", { status: "passed", pass_result: true, passed_checks: 4, failed_checks: 0 }),
    makeRun("b2", "flow/task-two"),
  ];
  return render(
    <CompareClient
      projectId="p1"
      batchA={makeBatch("bch-aaa", left)}
      batchB={makeBatch("bch-bbb", right)}
      inventory={[]}
      leftRuns={left}
      rightRuns={right}
    />,
  );
}

// ─── tabs ─────────────────────────────────────────────────────────────────

describe("CompareClient tabs", () => {
  it("renders Tasks and Summary tabs once both runs are picked", () => {
    setup();
    expect(screen.getByRole("tab", { name: /tasks/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /summary/i })).toBeTruthy();
  });

  it("Tasks tab: pickers + plain changed line, no aggregate band", () => {
    setup();
    expect(document.body.textContent).toContain("1 of 2 tasks changed");
    // pickers carry identity, not stats
    expect(screen.getByText(/#bch-aaa/)).toBeTruthy();
    expect(screen.queryByText(/checks \d+\/\d+ →/i)).toBeNull();
  });

  it("Summary tab: verdict sentence, totals table, per-task chart — no task tree", () => {
    setup("summary");
    expect(document.body.textContent).toContain("Run B fixes 1");
    expect(document.body.textContent).toContain("nothing regresses");
    expect(screen.getByRole("group", { name: /per-task cost comparison/i })).toBeTruthy();
    expect(document.body.textContent).toContain("totals");
    // the working view's tree does not leak into Summary
    expect(screen.queryByText(/tasks changed/i)).toBeNull();
  });

  it("clicking a tab updates the URL shallowly (no server refetch)", () => {
    setup();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /summary/i }));
    expect(window.location.search).toContain("tab=summary");
  });

  it("one-sided compare: picker prompt renders, no tabs, no verdict", () => {
    const left = [makeRun("a1", "flow/task-one")];
    render(
      <CompareClient
        projectId="p1"
        batchA={makeBatch("bch-aaa", left)}
        batchB={null}
        inventory={[]}
        leftRuns={left}
        rightRuns={[]}
      />,
    );
    expect(screen.getByText(/choose a run on the runs page/i)).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /summary/i })).toBeNull();
  });
});
