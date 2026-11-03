import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunEvent } from "@/hooks/use-run-events";
import type { AgentTaskRunSummary } from "@/lib/agent-task-api";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

interface CapturedOptions {
  enabled: boolean;
  onEvent: (event: RunEvent) => void;
  onReconnect?: () => void;
  onOpen?: () => void;
  closeWhenHidden?: boolean;
}
let hookOptions: CapturedOptions;
vi.mock("@/hooks/use-run-events", () => ({
  useRunEvents: (options: CapturedOptions) => {
    hookOptions = options;
  },
}));

import { TaskRunsAutoRefresh } from "../task-runs-auto-refresh";

const TASK = "chat/column-analysis/save-to-table";

const run = (id: string, status: string): AgentTaskRunSummary =>
  ({ id, status, task_id: TASK }) as AgentTaskRunSummary;

const event = (event_type: string, task_run_id: string, task_id = TASK): RunEvent => ({
  event_type,
  project: "proj-1",
  data: { task_run_id, task_id, batch_run_id: "b1" },
  timestamp: "2026-11-03T00:00:00Z",
});

const emit = (e: RunEvent) => act(() => hookOptions.onEvent(e));
const flush = () => act(() => vi.advanceTimersByTime(1_000));

const renderFor = (runs: AgentTaskRunSummary[], watchForNewRuns = true) =>
  render(
    <TaskRunsAutoRefresh project="proj-1" taskId={TASK} runs={runs} watchForNewRuns={watchForNewRuns} />,
  );

describe("TaskRunsAutoRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("listens, and closes the stream while the tab is hidden", () => {
    renderFor([]);
    expect(hookOptions.enabled).toBe(true);
    expect(hookOptions.closeWhenHidden).toBe(true);
  });

  it("stays off for a task that cannot get new runs, unless one is unsettled", () => {
    const { rerender } = renderFor([run("r1", "passed")], false);
    expect(hookOptions.enabled).toBe(false);

    rerender(
      <TaskRunsAutoRefresh project="proj-1" taskId={TASK} runs={[run("r1", "pending")]} watchForNewRuns={false} />,
    );
    expect(hookOptions.enabled).toBe(true);
  });

  it("refreshes on the first open only while a listed run is unsettled", () => {
    renderFor([run("r1", "passed")]);
    act(() => hookOptions.onOpen?.());
    flush();
    expect(refresh).not.toHaveBeenCalled();

    renderFor([run("r1", "running")]);
    act(() => hookOptions.onOpen?.());
    flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores the replay of a run once a refresh lists it as running", () => {
    const { rerender } = renderFor([]);
    emit(event("task_run.started", "r2"));
    flush();
    expect(refresh).toHaveBeenCalledTimes(1);

    rerender(
      <TaskRunsAutoRefresh project="proj-1" taskId={TASK} runs={[run("r3", "running")]} watchForNewRuns />,
    );
    emit(event("task_run.started", "r3"));
    flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes within a second of the first event, even under a steady stream", () => {
    renderFor([run("r1", "running"), run("r2", "running"), run("r3", "running")]);
    emit(event("task_run.completed", "r1"));
    act(() => vi.advanceTimersByTime(600));
    emit(event("task_run.completed", "r2"));
    act(() => vi.advanceTimersByTime(400));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes once when a new run of this task starts", () => {
    renderFor([run("r1", "passed")]);
    emit(event("task_run.started", "r2"));
    emit(event("task_run.started", "r2"));
    flush();
    expect(refresh).toHaveBeenCalledTimes(1);

    emit(event("task_run.started", "r2"));
    flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores the connect replay of a run already listed as running", () => {
    renderFor([run("r1", "running")]);
    emit(event("task_run.started", "r1"));
    flush();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes when a run of this task finishes or errors", () => {
    renderFor([run("r1", "running")]);
    emit(event("task_run.completed", "r1"));
    flush();
    emit(event("task_run.error", "r3"));
    flush();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("ignores other tasks' runs", () => {
    renderFor([]);
    emit(event("task_run.started", "r9", "other/task"));
    emit(event("task_run.completed", "r9", "other/task"));
    flush();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("coalesces a burst into one refresh", () => {
    renderFor([run("r1", "running"), run("r2", "running")]);
    emit(event("task_run.completed", "r1"));
    emit(event("task_run.completed", "r2"));
    flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes once after a reconnect, which also reports an open", () => {
    renderFor([run("r1", "running")]);
    act(() => {
      hookOptions.onOpen?.();
      hookOptions.onReconnect?.();
    });
    flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
