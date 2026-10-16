import { describe, expect, it } from "vitest";

import type { AgentTaskRunStats, AgentTaskSummary } from "@/lib/agent-task-api";
import { TASK_STATUS_FILTERS } from "@/lib/filter-status";
import { STATUS_CONFIG, getTaskStatus, taskFilterStatus } from "../task-list-shared";
import { notStartedLabel, provenanceLabel } from "../TaskCard";

function task(stats: Partial<AgentTaskRunStats>): AgentTaskSummary {
  return {
    id: "t",
    task_path: "t",
    folder_path: "",
    display_name: "t",
    adapter_name: "a",
    has_checks: true,
    tags: [],
    run_stats: {
      total_runs: 1,
      passed_runs: 0,
      failed_runs: 0,
      errored_runs: 1,
      pass_rate: 0,
      avg_duration_ms: null,
      last_run_at: null,
      last_run_status: "error",
      last_run_passed: null,
      total_checks: 0,
      checks_pass_rate: 0,
      avg_cost: null,
      ...stats,
    },
  };
}

// An `error` latest run is never a red FAILED card (issue #323).
describe("getTaskStatus", () => {
  it("reads a judge no-verdict latest run as No verdict", () => {
    const status = getTaskStatus(task({ last_run_no_verdict: true }));
    expect(status).toBe("no_verdict");
    expect(STATUS_CONFIG.no_verdict.label).toBe("No verdict");
    expect(STATUS_CONFIG.no_verdict.text).toBe("text-warning");
  });

  it("reads an execution error as Errored, agreeing with the filter", () => {
    const t = task({ last_run_no_verdict: false });
    expect(getTaskStatus(t)).toBe("errored");
    expect(taskFilterStatus(t)).toBe("errored");
    expect(STATUS_CONFIG.errored.text).toBe("text-warning");
  });

  it("reads a pending latest run as running, never FAILED", () => {
    expect(getTaskStatus(task({ last_run_status: "pending", last_run_passed: null }))).toBe("running");
  });

  it("filters a judge no-verdict task under its own No verdict value", () => {
    const t = task({ last_run_no_verdict: true });
    expect(taskFilterStatus(t)).toBe("no_verdict");
    expect(TASK_STATUS_FILTERS.map((f) => f.value)).toContain("no_verdict");
  });

  it("keeps passed and failed", () => {
    expect(getTaskStatus(task({ last_run_status: "passed", last_run_passed: true }))).toBe("passed");
    expect(getTaskStatus(task({ last_run_status: "failed", last_run_passed: false }))).toBe("failed");
  });
});

// The backend leaves runs that never started out of the stats (no executor
// claimed them before the queue TTL), so such a task reads as not run.
describe("a task whose only runs never started", () => {
  it("is idle, not Errored, and says its runs never started", () => {
    const t = task({
      total_runs: 0,
      errored_runs: 0,
      last_run_status: null,
      not_started_runs: 2,
    });
    expect(getTaskStatus(t)).toBe("idle");
    expect(notStartedLabel(t.run_stats?.not_started_runs ?? 0)).toBe("2 runs never started");
    expect(notStartedLabel(1)).toBe("1 run never started");
    expect(notStartedLabel(0)).toBe("Ready to run");
  });
});

describe("provenanceLabel", () => {
  it("prefers the git author of the adding commit, with its date", () => {
    expect(
      provenanceLabel({
        ...baseTask(),
        git_author_name: "Teammate",
        git_first_commit_at: "2026-10-02T09:30:00Z",
        first_published_at: "2026-10-14T12:00:00Z",
        first_published_by: "Publisher",
      }),
    ).toBe("Added 2026-10-02 by Teammate");
  });

  it("falls back to first-published when git history was unavailable", () => {
    expect(
      provenanceLabel({
        ...baseTask(),
        first_published_at: "2026-10-14T12:00:00Z",
        first_published_by: "Publisher",
      }),
    ).toBe("Added 2026-10-14 by Publisher");
  });

  it("shows the date alone when no name is known", () => {
    expect(provenanceLabel({ ...baseTask(), first_published_at: "2026-10-14T12:00:00Z" }))
      .toBe("Added 2026-10-14");
  });

  it("renders nothing without any provenance (older backends)", () => {
    expect(provenanceLabel(baseTask())).toBeNull();
  });
});

function baseTask(): AgentTaskSummary {
  return {
    id: "t",
    task_path: "t",
    folder_path: "",
    display_name: "t",
    adapter_name: "a",
    has_checks: true,
    tags: [],
    run_stats: null,
  };
}
