import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TaskCard } from "@/app/project/[projectId]/tasks/components/TaskCard";
import { TaskRunRow } from "@/components/task-run-list";
import type { AgentTaskRunSummary, AgentTaskSummary } from "@/lib/agent-task-api";

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
  started_at: null,
  completed_at: null,
  total_cost: null,
  total_tokens: null,
  total_checks: 1,
  passed_checks: 1,
  failed_checks: 0,
  errored_checks: 0,
  error_message: null,
  trigger: null,
} as AgentTaskRunSummary;

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

    expect(screen.getByRole("link").getAttribute("data-prefetch")).toBe("false");
  });

  it("does not viewport-prefetch every run detail page", () => {
    render(
      <table>
        <tbody>
          <TaskRunRow run={run} projectId="acme" />
        </tbody>
      </table>,
    );

    expect(screen.getByRole("link", { name: task.id }).getAttribute("data-prefetch")).toBe(
      "false",
    );
  });
});
