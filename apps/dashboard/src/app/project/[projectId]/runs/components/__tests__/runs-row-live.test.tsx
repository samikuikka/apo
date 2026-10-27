/**
 * A runs-list row whose summary is replaced by a live refresh must not keep
 * showing the task runs it cached on first expand.
 */

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentTaskBatchRunDetail, AgentTaskBatchRunSummary, AgentTaskRunSummary } from "@/lib/agent-task-api";

const getAgentTaskBatchRun = vi.fn<(id: string) => Promise<AgentTaskBatchRunDetail>>();
vi.mock("@/lib/agent-task-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-task-api")>()),
  getAgentTaskBatchRun: (id: string) => getAgentTaskBatchRun(id),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/runs/DeleteRunButton", () => ({
  DeleteRunButton: ({
    target,
    onDeleted,
  }: {
    target: { kind: string; taskRunId?: string };
    onDeleted?: () => void;
  }) =>
    target.kind === "task-run" ? (
      <button type="button" onClick={onDeleted}>
        delete {target.taskRunId}
      </button>
    ) : null,
}));

import { RunsRow } from "../RunsRow";

const summary = (
  status: string,
  passed = 0,
  overrides: Partial<AgentTaskBatchRunSummary> = {},
): AgentTaskBatchRunSummary =>
  ({
    ...overrides,
    id: "batch-1",
    project: "acme",
    selection_type: "all",
    selection_query: null,
    task_root: null,
    grep: null,
    environment: "local",
    status,
    total_tasks: 2,
    passed_tasks: passed,
    failed_tasks: 0,
    errored_tasks: 0,
    total_checks: 0,
    passed_checks: 0,
    created_at: "2026-09-14T00:00:00Z",
    started_at: "2026-09-14T00:00:00Z",
    completed_at: null,
    trigger: null,
    trace_persistence_status: "complete",
    trace_error_message: null,
    total_cost: null,
    total_tokens: null,
    configuration: { state: "unknown", configurations: [], reported_task_runs: 0, total_task_runs: 2 },
    labels: {},
    ...overrides,
  }) as unknown as AgentTaskBatchRunSummary;

const taskRun = (id: string, status: string): AgentTaskRunSummary =>
  ({ id, task_id: id, status, adapter_name: "demo", run_configuration: null }) as unknown as AgentTaskRunSummary;

const detail = (...runs: AgentTaskRunSummary[]): AgentTaskBatchRunDetail =>
  ({ task_runs: runs }) as unknown as AgentTaskBatchRunDetail;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

function Row({ batch, taskStartTick }: { batch: AgentTaskBatchRunSummary; taskStartTick?: number }) {
  return (
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
          taskStartTick={taskStartTick}
        />
      </tbody>
    </table>
  );
}

describe("RunsRow under live refresh", () => {
  beforeEach(() => {
    getAgentTaskBatchRun.mockReset();
  });

  it("re-fetches expanded task runs when a running batch's summary changes", async () => {
    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("task-a", "running"), taskRun("task-b", "queued")));
    const view = render(<Row batch={summary("running")} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    expect(await screen.findByRole("link", { name: "task-a" })).toBeInTheDocument();

    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("task-a", "passed"), taskRun("task-c", "running")));
    view.rerender(<Row batch={summary("running", 1)} />);

    expect(await screen.findByRole("link", { name: "task-c" })).toBeInTheDocument();
    expect(getAgentTaskBatchRun).toHaveBeenCalledTimes(2);
  });

  it("keeps the expanded rows on screen while a live re-fetch is in flight", async () => {
    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("task-a", "running")));
    const view = render(<Row batch={summary("running")} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    await screen.findByRole("link", { name: "task-a" });

    const pending = deferred<AgentTaskBatchRunDetail>();
    getAgentTaskBatchRun.mockReturnValueOnce(pending.promise);
    view.rerender(<Row batch={summary("running", 1)} />);
    await act(async () => {});

    expect(screen.getByRole("link", { name: "task-a" })).toBeInTheDocument();
    expect(screen.queryByText(/Loading task runs/)).toBeNull();

    await act(async () => pending.resolve(detail(taskRun("task-b", "running"))));
    expect(screen.getByRole("link", { name: "task-b" })).toBeInTheDocument();
  });

  it("keeps the current rows when a live re-fetch fails", async () => {
    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("task-a", "running")));
    const view = render(<Row batch={summary("running")} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    await screen.findByRole("link", { name: "task-a" });

    getAgentTaskBatchRun.mockRejectedValueOnce(new Error("backend blip"));
    view.rerender(<Row batch={summary("running", 1)} />);
    await act(async () => {});

    expect(screen.getByRole("link", { name: "task-a" })).toBeInTheDocument();
    expect(screen.queryByText("backend blip")).toBeNull();
  });

  it("re-fetches once more when the batch finishes", async () => {
    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("task-a", "running")));
    const view = render(<Row batch={summary("running")} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    await screen.findByRole("link", { name: "task-a" });

    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("task-done", "passed")));
    view.rerender(<Row batch={summary("completed", 2)} />);
    expect(await screen.findByRole("link", { name: "task-done" })).toBeInTheDocument();
  });

  it("does not re-fetch a finished batch whose summary is re-rendered", async () => {
    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("task-a", "passed")));
    const view = render(<Row batch={summary("completed", 2)} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    await screen.findByRole("link", { name: "task-a" });

    view.rerender(<Row batch={summary("completed", 2)} />);
    await act(async () => {});
    expect(getAgentTaskBatchRun).toHaveBeenCalledTimes(1);
  });

  it("drops the cached task runs of a collapsed row so the next expand loads fresh ones", async () => {
    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("stale", "running")));
    const view = render(<Row batch={summary("running")} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    await screen.findByRole("link", { name: "stale" });
    await userEvent.click(screen.getByRole("button", { name: "Collapse task runs" }));

    view.rerender(<Row batch={summary("completed", 2)} />);
    expect(getAgentTaskBatchRun).toHaveBeenCalledTimes(1);

    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("fresh", "passed")));
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    expect(await screen.findByRole("link", { name: "fresh" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "stale" })).toBeNull();
  });

  it("does not re-fetch when a refresh re-renders an unchanged running summary", async () => {
    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("task-a", "running")));
    const view = render(<Row batch={summary("running")} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    await screen.findByRole("link", { name: "task-a" });

    for (let i = 0; i < 3; i++) view.rerender(<Row batch={summary("running")} />);
    await act(async () => {});
    expect(getAgentTaskBatchRun).toHaveBeenCalledTimes(1);
  });

  it("does not cache a load that was in flight when a collapsed row was invalidated", async () => {
    const first = deferred<AgentTaskBatchRunDetail>();
    getAgentTaskBatchRun.mockReturnValueOnce(first.promise);
    const view = render(<Row batch={summary("running")} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    await userEvent.click(screen.getByRole("button", { name: "Collapse task runs" }));

    view.rerender(<Row batch={summary("completed", 2)} />);
    await act(async () => first.resolve(detail(taskRun("stale", "running"))));

    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("fresh", "passed")));
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    expect(await screen.findByRole("link", { name: "fresh" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "stale" })).toBeNull();
  });

  it("shows the error when the load that replaced a first load fails", async () => {
    const first = deferred<AgentTaskBatchRunDetail>();
    getAgentTaskBatchRun.mockReturnValueOnce(first.promise);
    const view = render(<Row batch={summary("running")} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));

    getAgentTaskBatchRun.mockRejectedValueOnce(new Error("backend down"));
    view.rerender(<Row batch={summary("running", 1)} />);
    await act(async () => first.resolve(detail(taskRun("older", "running"))));

    expect(await screen.findByText("backend down")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "older" })).toBeNull();
  });

  it("keeps the spinner until the newest load lands", async () => {
    const first = deferred<AgentTaskBatchRunDetail>();
    const second = deferred<AgentTaskBatchRunDetail>();
    getAgentTaskBatchRun.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<Row batch={summary("running")} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    view.rerender(<Row batch={summary("running", 1)} />);

    await act(async () => first.resolve(detail(taskRun("older", "running"))));
    expect(screen.getByText(/Loading task runs/)).toBeInTheDocument();

    await act(async () => second.resolve(detail(taskRun("newer", "running"))));
    expect(screen.queryByText(/Loading task runs/)).toBeNull();
    expect(screen.getByRole("link", { name: "newer" })).toBeInTheDocument();
  });

  it("ignores an older load's failure once a newer load has landed", async () => {
    const first = deferred<AgentTaskBatchRunDetail>();
    getAgentTaskBatchRun.mockReturnValueOnce(first.promise);
    const view = render(<Row batch={summary("running")} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));

    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("newer", "passed")));
    view.rerender(<Row batch={summary("completed", 2)} />);
    await screen.findByRole("link", { name: "newer" });

    await act(async () => {
      first.resolve(Promise.reject(new Error("older failed")) as never);
    });
    await act(async () => {});
    expect(screen.queryByText("older failed")).toBeNull();
    expect(screen.getByRole("link", { name: "newer" })).toBeInTheDocument();
  });

  it("does not let a re-fetch that was in flight restore a deleted task run", async () => {
    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("task-a", "passed"), taskRun("task-b", "running")));
    const view = render(<Row batch={summary("running", 1)} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    await screen.findByRole("link", { name: "task-a" });

    const inFlight = deferred<AgentTaskBatchRunDetail>();
    getAgentTaskBatchRun.mockReturnValueOnce(inFlight.promise);
    view.rerender(<Row batch={summary("completed", 2)} />);
    await userEvent.click(screen.getByRole("button", { name: "delete task-a" }));

    await act(async () => inFlight.resolve(detail(taskRun("task-a", "passed"), taskRun("task-b", "passed"))));
    expect(screen.queryByRole("link", { name: "task-a" })).toBeNull();
    // The in-flight response is still the batch's final state for the rest.
    expect(screen.getByRole("link", { name: "task-b" }).closest("tr")).toHaveTextContent(/Passed/);
  });

  it("re-fetches expanded task runs when a task of the batch starts", async () => {
    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("task-a", "running"), taskRun("task-b", "pending")));
    const view = render(<Row batch={summary("running")} taskStartTick={0} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    await screen.findByRole("link", { name: "task-a" });

    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("task-a", "running"), taskRun("task-b", "running")));
    view.rerender(<Row batch={summary("running")} taskStartTick={1} />);
    await act(async () => {});
    expect(getAgentTaskBatchRun).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("link", { name: "task-b" }).closest("tr")).toHaveTextContent(/Running/);
  });

  it.each([
    ["the status moves on with no count changing", summary("queued"), summary("running")],
    ["a task fails", summary("running"), summary("running", 0, { failed_tasks: 1 })],
    ["a task errors", summary("running"), summary("running", 0, { errored_tasks: 1 })],
    ["a check is recorded", summary("running"), summary("running", 0, { total_checks: 3 })],
    ["a check passes", summary("running", 0, { total_checks: 3 }), summary("running", 0, { total_checks: 3, passed_checks: 2 })],
  ])("re-fetches expanded task runs when %s", async (_label, before, after) => {
    getAgentTaskBatchRun.mockResolvedValue(detail(taskRun("task-a", "running")));
    const view = render(<Row batch={before} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));
    await screen.findByRole("link", { name: "task-a" });

    view.rerender(<Row batch={after} />);
    await act(async () => {});
    expect(getAgentTaskBatchRun).toHaveBeenCalledTimes(2);
  });

  it("never lets an older response overwrite a newer one", async () => {
    const first = deferred<AgentTaskBatchRunDetail>();
    getAgentTaskBatchRun.mockReturnValueOnce(first.promise);
    const view = render(<Row batch={summary("running")} />);
    await userEvent.click(screen.getByRole("button", { name: "Expand task runs" }));

    getAgentTaskBatchRun.mockResolvedValueOnce(detail(taskRun("newer", "passed")));
    view.rerender(<Row batch={summary("completed", 2)} />);
    expect(await screen.findByRole("link", { name: "newer" })).toBeInTheDocument();

    await act(async () => first.resolve(detail(taskRun("older", "running"))));
    expect(screen.queryByRole("link", { name: "older" })).toBeNull();
    expect(screen.getByRole("link", { name: "newer" })).toBeInTheDocument();
  });
});
