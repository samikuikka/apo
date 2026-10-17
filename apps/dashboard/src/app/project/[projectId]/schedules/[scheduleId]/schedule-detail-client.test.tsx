/**
 * Scene tests: "Run now" failure surfacing (issue #465).
 *
 * 1. A refused trigger (hard-paused 409) shows the actionable refusal copy,
 *    never navigates, and re-enables the button.
 * 2. A 422 published-catalog refusal points at apo connect.
 * 3. An unexpected failure still surfaces instead of dying as an unhandled
 *    promise rejection.
 * 4. Success still navigates to the batch run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentTaskScheduleDetail } from "@/lib/agent-task-api";
import { ApiError } from "@/lib/api-error";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/lib/project-router", () => ({
  useProjectId: () => "acme",
  useIsDemo: () => false,
  DEFAULT_PROJECT: "example-service",
  DEMO_PROJECT: "demo",
}));

vi.mock("@/lib/agent-task-api", () => ({
  triggerSchedule: vi.fn(),
  updateAgentTaskSchedule: vi.fn(),
  listScheduleOccurrences: vi.fn().mockResolvedValue({ occurrences: [] }),
}));

import { triggerSchedule } from "@/lib/agent-task-api";
import { ScheduleDetailClient } from "@/app/project/[projectId]/schedules/[scheduleId]/schedule-detail-client";

function schedule(
  overrides: Partial<AgentTaskScheduleDetail> = {},
): AgentTaskScheduleDetail {
  return {
    id: "sch-1",
    project: "acme",
    name: "Nightly",
    selection_type: "tasks",
    selection_query: null,
    task_root: null,
    grep: null,
    environment: "prod",
    cadence_type: "daily",
    timezone: "UTC",
    hour: 6,
    minute: 0,
    day_of_week: null,
    day_of_month: null,
    min_interval_days: 1,
    max_interval_days: 30,
    enabled: true,
    executor_pool_id: null,
    queue_ttl_seconds: 3600,
    disabled_reason: null,
    last_triggered_at: null,
    last_batch_run_id: null,
    next_run_at: "2026-10-18T06:00:00Z",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    last_batch: null,
    consecutive_failures: 0,
    execution_kind: "source_owned",
    execution_owner: { id: "u1", name: "Owner" },
    connected_environment_state: null,
    active_batch_run_id: null,
    latest_occurrence: null,
    missed_occurrences: 0,
    run_metadata: null,
    ...overrides,
  };
}

function renderDetail(overrides: Partial<AgentTaskScheduleDetail> = {}) {
  render(
    <ScheduleDetailClient
      projectId="acme"
      schedule={schedule(overrides)}
      adaptiveStates={[]}
      taskNames={new Map()}
      executorPools={[]}
    />,
  );
}

const runNow = () => fireEvent.click(screen.getByRole("button", { name: /run now/i }));

beforeEach(() => {
  vi.mocked(triggerSchedule).mockReset();
  push.mockReset();
});

describe("ScheduleDetailClient Run now failures", () => {
  it("shows the hard-paused refusal and stays on the page", async () => {
    vi.mocked(triggerSchedule).mockRejectedValue(
      new ApiError(
        409,
        "schedule is hard-paused",
        { kind: "execution_owner_unavailable", msg: "schedule is hard-paused" },
      ),
    );
    renderDetail();

    runNow();

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent(/no longer a project member/i);
    expect(push).not.toHaveBeenCalled();
    // The button recovers instead of staying stuck on "Starting…".
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /run now/i })).toBeEnabled(),
    );
  });

  it("points a published-catalog 422 at apo connect", async () => {
    vi.mocked(triggerSchedule).mockRejectedValue(
      new ApiError(
        422,
        "Published task catalogs contain metadata only. Tasks must be run from their source environment using caller execution.",
      ),
    );
    renderDetail();

    runNow();

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent(/connected executor \(apo connect\)/i);
    expect(push).not.toHaveBeenCalled();
  });

  it("surfaces an unexpected failure instead of rejecting silently", async () => {
    vi.mocked(triggerSchedule).mockRejectedValue(new Error("Network down"));
    renderDetail();

    runNow();

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent(/Network down/i);
    expect(push).not.toHaveBeenCalled();
  });

  it("still navigates to the batch run on success", async () => {
    vi.mocked(triggerSchedule).mockResolvedValue({
      batch_run_id: "batch-9",
      occurrence_id: null,
      created: true,
      schedule: {} as AgentTaskScheduleDetail,
    });
    renderDetail();

    runNow();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/project/acme/runs/batch-9"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
