import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentTaskBatchRunSummary } from "@/lib/agent-task-api";

import { formatDuration, getBatchName } from "../runs-utils";

describe("formatDuration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T11:23:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("measures start to end", () => {
    expect(formatDuration("2026-09-14T09:20:27.938671Z", "2026-09-14T09:20:41.335580Z", false)).toBe("13.4s");
  });

  it("counts a live run up to now", () => {
    expect(formatDuration("2026-09-14T11:20:00Z", null, true)).toBe("3m 00s");
  });

  it("does not count a finished run without an end up to now", () => {
    expect(formatDuration("2026-09-14T09:20:27.938671Z", null, false)).toBe("—");
  });
});

describe("getBatchName", () => {
  const batch = (
    selection_type: string,
    selection_query: Record<string, unknown> | null,
  ): AgentTaskBatchRunSummary =>
    ({ selection_type, selection_query }) as AgentTaskBatchRunSummary;

  it("names a one-task batch after the task", () => {
    expect(getBatchName(batch("tasks", { task_paths: ["drafting/redline-basic"] }))).toBe(
      "redline-basic",
    );
  });

  it("reads the queued snapshot's task ids", () => {
    expect(getBatchName(batch("tasks", { kind: "tasks", task_ids: ["drafting/redline-basic"] }))).toBe(
      "redline-basic",
    );
    expect(getBatchName(batch("tasks", { kind: "tasks", task_ids: ["a/one", "a/two"] }))).toBe(
      "2 tasks",
    );
    expect(getBatchName(batch("tasks", { kind: "all", task_ids: ["a/one", "a/two"] }))).toBe(
      "All discovered tasks",
    );
  });

  it("names folder selections as folders, not tasks", () => {
    expect(getBatchName(batch("folder", { task_paths: ["drafting/nda"] }))).toBe("drafting/nda");
    expect(getBatchName(batch("folder", { task_paths: ["drafting", "review"] }))).toBe("2 folders");
  });
});
