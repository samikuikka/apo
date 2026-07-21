import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../api-client";
import { listTaskRuns } from "../agent-task-api";

vi.mock("../api-client", () => ({
  apiClient: vi.fn(),
}));

describe("listTaskRuns", () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });

  it("uses the non-conflicting task-run collection endpoint", async () => {
    vi.mocked(apiClient).mockResolvedValue([]);

    await listTaskRuns("real-agent/documents/data-extraction", "project-1");

    expect(apiClient).toHaveBeenCalledWith("/v1/agent-task-runs", {
      cache: "no-store",
      query: {
        task_id: "real-agent/documents/data-extraction",
        project: "project-1",
      },
    });
  });
});
