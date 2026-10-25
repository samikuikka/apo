import { describe, it, expect } from "vitest";

import {
  TASK_RUN_STATUS,
  taskRunStatusConfig,
} from "@/components/task-run-list.utils";

// The backend's canonical run lifecycle (models/schemas.py TaskRunStatus).
// Every value the API can emit must render as itself — a drifted status once
// fell through an `?? "pending"` fallback and showed a finished run as
// "Pending" for days with no hint anything was wrong.
const CANONICAL_RUN_STATUSES = ["pending", "running", "passed", "failed", "error"] as const;

describe("taskRunStatusConfig", () => {
  it("keeps the known set in sync with the backend lifecycle", () => {
    expect(Object.keys(TASK_RUN_STATUS).sort()).toEqual([...CANONICAL_RUN_STATUSES].sort());
  });

  it("renders an unknown status with its raw label, never as Pending", () => {
    // "completed" is a batch status; it must not display as "Pending".
    const config = taskRunStatusConfig("completed");
    expect(config.label).toBe("completed");
    expect(config.label).not.toBe("Pending");
  });

  it("labels an empty status as unknown instead of Pending", () => {
    expect(taskRunStatusConfig("").label).toBe("unknown");
  });
});
