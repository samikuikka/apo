import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TaskCard } from "@/app/project/[projectId]/tasks/components/TaskCard";
import { RunsRow } from "@/app/project/[projectId]/runs/components/RunsRow";
import { InlineTaskRunRow } from "@/app/project/[projectId]/runs/components/InlineTaskRunRow";
import { TaskRunRow } from "@/components/task-run-list";
import type {
  AgentTaskBatchRunSummary,
  AgentTaskRunSummary,
  AgentTaskSummary,
} from "@/lib/agent-task-api";

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
function expectAllLinksCold() {
  const links = screen.getAllByRole("link");
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(link.getAttribute("data-prefetch")).toBe("false");
  }
}

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

    expectAllLinksCold();
  });

  it("does not viewport-prefetch every run detail page", () => {
    render(
      <table>
        <tbody>
          <TaskRunRow run={run} projectId="acme" />
        </tbody>
      </table>,
    );

    expectAllLinksCold();
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

    expectAllLinksCold();
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

    expectAllLinksCold();
  });
});
