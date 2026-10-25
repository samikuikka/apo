import { describe, expect, it } from "vitest";

import type { AgentTaskRunStats, AgentTaskSummary } from "@/lib/agent-task-api";
import { TASK_STATUS_FILTERS } from "@/lib/filter-status";
import { STATUS_CONFIG, getTaskStatus, taskFilterStatus } from "../task-list-shared";

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
  });

  it("reads an execution error as Errored, agreeing with the filter", () => {
    const t = task({ last_run_no_verdict: false });
    expect(getTaskStatus(t)).toBe("errored");
    expect(taskFilterStatus(t)).toBe("errored");
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
