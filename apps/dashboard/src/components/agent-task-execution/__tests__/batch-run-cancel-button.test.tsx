import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BatchRunCancelButton } from "../batch-run-cancel-button";
import { cancelAgentTaskBatchRun } from "@/lib/agent-task-api";

vi.mock("@/lib/agent-task-api", () => ({
  cancelAgentTaskBatchRun: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe("BatchRunCancelButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends one cancel request and shows a Cancelling state", async () => {
    const user = userEvent.setup();
    vi.mocked(cancelAgentTaskBatchRun).mockResolvedValueOnce({ ok: true, cancelled: 2 });
    render(<BatchRunCancelButton batchRunId="batch-1" />);

    await user.click(screen.getByRole("button", { name: /Cancel Run/i }));

    expect(cancelAgentTaskBatchRun).toHaveBeenCalledTimes(1);
    expect(cancelAgentTaskBatchRun).toHaveBeenCalledWith("batch-1");
  });

  it("is idempotent: a second click while pending is suppressed", async () => {
    const user = userEvent.setup();
    let resolveCancel!: (value: { ok: true; cancelled: number }) => void;
    vi.mocked(cancelAgentTaskBatchRun).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveCancel = resolve;
      }),
    );
    render(<BatchRunCancelButton batchRunId="batch-1" />);

    const button = screen.getByRole("button", { name: /Cancel Run/i });
    await user.click(button);
    await user.click(button); // second click while in flight

    expect(cancelAgentTaskBatchRun).toHaveBeenCalledTimes(1);
    resolveCancel({ ok: true, cancelled: 1 });
  });

  it("surfaces an actionable error when the request fails", async () => {
    const user = userEvent.setup();
    vi.mocked(cancelAgentTaskBatchRun).mockRejectedValueOnce(new Error("offline"));
    render(<BatchRunCancelButton batchRunId="batch-1" />);

    await user.click(screen.getByRole("button", { name: /Cancel Run/i }));

    const { toast } = await import("sonner");
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Cancel failed/i));
  });
});
