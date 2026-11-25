import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TaskCard } from "@/app/project/[projectId]/tasks/components/TaskCard";
import { RunsRow } from "@/app/project/[projectId]/runs/components/RunsRow";
import { InlineTaskRunRow } from "@/app/project/[projectId]/runs/components/InlineTaskRunRow";
import { TraceIdCell, TraceNameCell } from "@/app/project/[projectId]/traces/columns";
import { ScheduleDetailClient } from "@/app/project/[projectId]/schedules/[scheduleId]/schedule-detail-client";
import { TaskRunRow } from "@/components/task-run-list";
import type {
  AdaptiveTaskState,
  AgentTaskBatchRunSummary,
  AgentTaskRunSummary,
  AgentTaskScheduleDetail,
  AgentTaskSummary,
} from "@/lib/agent-task-api";
import type { TraceSummary } from "@/lib/traces-api";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    prefetch,
    ...props
  }: {
    children: ReactNode;
    href: string;
    prefetch?: boolean;
  }) => (
    <a href={href} data-prefetch={String(prefetch)} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/project-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-router")>();
  return {
    ...actual,
    useIsDemo: () => false,
    useProjectId: () => "acme",
  };
});

vi.mock("@/lib/agent-task-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-task-api")>();
  return {
    ...actual,
    // The schedule page fetches its occurrence history on mount; a
    // never-resolving promise keeps that state update out of this test.
    listScheduleOccurrences: vi.fn(() => new Promise(() => {})),
  };
});

const task: AgentTaskSummary = {
  id: "support/refund",
  task_path: "support/refund.eval.ts",
  folder_path: "support",
  display_name: "Refund request",
  adapter_name: "claude-code",
  has_checks: true,
  tags: [],
  run_stats: null,
};

const run: AgentTaskRunSummary = {
  id: "run_abc",
  batch_run_id: "batch_1",
  task_id: task.id,
  task_path: task.task_path,
  adapter_name: "claude-code",
  status: "passed",
  pass_result: true,
  started_at: "2026-11-20T10:00:00Z",
  completed_at: "2026-11-20T10:01:00Z",
  trace_run_id: null,
  primary_model: null,
  task_source_commit_sha: null,
  error_message: null,
  total_cost: null,
  total_tokens: null,
  total_checks: 1,
  passed_checks: 1,
  failed_checks: 0,
  trigger: null,
  trace_persistence_status: "persisted",
  trace_error_message: null,
  error_category: null,
  run_configuration: null,
  environment: null,
  labels: {},
};

const batch: AgentTaskBatchRunSummary = {
  id: "batch_1",
  project: "acme",
  selection_type: "all",
  selection_query: null,
  task_root: null,
  grep: null,
  environment: "local",
  status: "completed",
  total_tasks: 2,
  passed_tasks: 2,
  failed_tasks: 0,
  errored_tasks: 0,
  total_checks: 1,
  passed_checks: 1,
  created_at: "2026-11-20T10:00:00Z",
  started_at: "2026-11-20T10:00:00Z",
  completed_at: "2026-11-20T10:01:00Z",
  trigger: null,
  trace_persistence_status: "persisted",
  trace_error_message: null,
  total_cost: null,
  total_tokens: null,
  configuration: { state: "unknown", configurations: [], reported_task_runs: 0, total_task_runs: 2 },
  labels: {},
};

/** Every link a row renders must opt out: one prefetching link in a list
 *  re-requests every destination server page as it scrolls by. */
function expectAllLinksCold(links: HTMLElement[]) {
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(link.getAttribute("data-prefetch")).toBe("false");
  }
}

const trace: TraceSummary = {
  id: "trace_abcdefghij",
  project: "acme",
  scopeKey: "agent-task.e2e",
  task_id: task.id,
  version: null,
  session_id: null,
  environment: "local",
  tags: [],
  user_id: null,
  primary_model: null,
  providers: [],
  serviceName: null,
  call_count: 1,
  duration_ms: 1000,
  created_at: "2026-11-24T10:00:00Z",
  completed_at: "2026-11-24T10:01:00Z",
  status: "ok",
  error_count: 0,
  warning_count: 0,
  metrics: [],
  input_preview: null,
  output_preview: null,
  bookmarked: false,
};

const adaptiveState: AdaptiveTaskState = {
  task_id: task.id,
  task_path: task.task_path,
  current_interval_days: 3,
  ease_factor: 2.5,
  consecutive_passes: 2,
  last_run_at: "2026-11-24T10:00:00Z",
  last_status: "passed",
  next_run_at: "2026-11-27T10:00:00Z",
};

const schedule: AgentTaskScheduleDetail = {
  id: "schedule_1",
  project: "acme",
  name: "Nightly",
  selection_type: "all",
  selection_query: null,
  task_root: null,
  grep: null,
  environment: "local",
  cadence_type: "adaptive",
  timezone: "UTC",
  hour: 3,
  minute: 0,
  day_of_week: null,
  day_of_month: null,
  min_interval_days: 1,
  max_interval_days: 30,
  enabled: true,
  executor_pool_id: null,
  queue_ttl_seconds: 600,
  disabled_reason: null,
  last_triggered_at: "2026-11-23T03:00:00Z",
  last_batch_run_id: batch.id,
  next_run_at: "2026-11-27T10:00:00Z",
  created_at: "2026-11-20T10:00:00Z",
  updated_at: "2026-11-20T10:00:00Z",
  last_batch: null,
  consecutive_failures: 0,
  execution_kind: "source_owned",
  execution_owner: null,
  connected_environment_state: null,
  active_batch_run_id: null,
  latest_occurrence: null,
  missed_occurrences: 0,
  run_metadata: null,
};

describe("detail links in high-cardinality lists", () => {
  it("does not viewport-prefetch every task detail page", () => {
    render(
      <TaskCard
        task={task}
        isSel={false}
        status="idle"
        stats={null}
        isDemoProject={false}
        toggleTask={vi.fn()}
      />,
    );

    expectAllLinksCold(screen.getAllByRole("link"));
  });

  it("does not viewport-prefetch every run detail page", () => {
    render(
      <table>
        <tbody>
          <TaskRunRow run={run} projectId="acme" />
        </tbody>
      </table>,
    );

    expectAllLinksCold(screen.getAllByRole("link"));
  });

  it("does not viewport-prefetch every batch detail page", () => {
    render(
      <table>
        <tbody>
          <RunsRow
            batch={batch}
            clientNow={null}
            projectId="acme"
            compareSelected={false}
            compareDisabled={false}
            onToggleCompare={() => {}}
            modelFilter={new Set()}
            canDelete={false}
          />
        </tbody>
      </table>,
    );

    expectAllLinksCold(screen.getAllByRole("link"));
  });

  it("does not viewport-prefetch every inline run detail page", () => {
    render(
      <table>
        <tbody>
          <InlineTaskRunRow
            run={run}
            projectId="acme"
            clientNow={null}
            canDelete={false}
            onDeleted={() => {}}
          />
        </tbody>
      </table>,
    );

    expectAllLinksCold(screen.getAllByRole("link"));
  });

  it("does not viewport-prefetch every trace detail page", () => {
    render(<TraceNameCell trace={trace} projectId="acme" />);

    expectAllLinksCold(screen.getAllByRole("link"));
  });

  it("does not viewport-prefetch the trace row id link", () => {
    render(<TraceIdCell trace={trace} projectId="acme" />);

    expectAllLinksCold(screen.getAllByRole("link"));
  });

  it("does not viewport-prefetch every task in a schedule's adaptive table", () => {
    render(
      <ScheduleDetailClient
        projectId="acme"
        schedule={schedule}
        adaptiveStates={[adaptiveState]}
        taskNames={new Map([[task.id, task]])}
        executorPools={[]}
      />,
    );

    // Header links on a detail page may prefetch on hover; the links inside
    // the per-task table are a list and must stay cold.
    expectAllLinksCold(within(screen.getByRole("table")).getAllByRole("link"));
  });
});
