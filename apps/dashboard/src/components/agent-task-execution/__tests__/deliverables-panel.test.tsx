import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DeliverablesPanel } from "../deliverables-panel";
import {
  fetchDeliverableBody,
  type DeliverableSummary,
} from "@/lib/agent-task-deliverables-api";

vi.mock("@/lib/agent-task-deliverables-api", () => ({
  fetchDeliverableBody: vi.fn(),
}));

vi.mock("@/components/shiki-code-block", () => ({
  ShikiCodeBlock: ({ code }: { code: string }) => (
    <pre data-testid="shiki">{code}</pre>
  ),
}));

vi.mock("@/components/ExpandableJson", () => ({
  ExpandableJson: ({ data }: { data: unknown }) => (
    <div data-testid="expandable-json">{JSON.stringify(data)}</div>
  ),
}));

function jsonItem(overrides: Partial<DeliverableSummary> = {}): DeliverableSummary {
  return {
    id: "dlv_1",
    name: "verdict",
    kind: "json",
    status: "ready",
    media_type: "application/json",
    display_filename: null,
    size_bytes: 42,
    sha256: "a".repeat(64),
    download_url: "/v1/agent-task-runs/run-1/deliverables/dlv_1",
    ...overrides,
  };
}

describe("DeliverablesPanel", () => {
  beforeEach(() => {
    vi.mocked(fetchDeliverableBody).mockReset();
  });

  it("renders the manifest without loading any body", () => {
    render(<DeliverablesPanel items={[jsonItem(), jsonItem({ id: "dlv_2", name: "summary" })]} />);
    expect(screen.getByText("verdict")).toBeInTheDocument();
    expect(screen.getByText("summary")).toBeInTheDocument();
    expect(screen.getAllByText("42 bytes")).toHaveLength(2);
    expect(fetchDeliverableBody).not.toHaveBeenCalled();
  });

  it("shows an empty state when there are no items", () => {
    render(<DeliverablesPanel items={[]} />);
    expect(screen.getByText("No deliverables")).toBeInTheDocument();
  });

  it("fetches exactly one body when a JSON row is expanded", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchDeliverableBody).mockResolvedValue({ reward: 1 });
    render(<DeliverablesPanel items={[jsonItem(), jsonItem({ id: "dlv_2", name: "other" })]} />);

    await user.click(screen.getByLabelText("Toggle deliverable verdict"));

    expect(fetchDeliverableBody).toHaveBeenCalledTimes(1);
    expect(fetchDeliverableBody).toHaveBeenCalledWith(
      "/v1/agent-task-runs/run-1/deliverables/dlv_1",
      expect.any(AbortSignal),
    );
    expect(screen.getByTestId("expandable-json")).toBeInTheDocument();
  });

  it("aborts the in-flight fetch when collapsed", async () => {
    const user = userEvent.setup();
    // Never resolves so the abort path is exercised.
    vi.mocked(fetchDeliverableBody).mockImplementation(
      (_url: string, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          if (signal) {
            signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }
        }),
    );
    render(<DeliverablesPanel items={[jsonItem()]} />);

    await user.click(screen.getByLabelText("Toggle deliverable verdict"));
    expect(fetchDeliverableBody).toHaveBeenCalled();
    // Collapse -> abort.
    await user.click(screen.getByLabelText("Toggle deliverable verdict"));
    // The fetch was called once; no stale state update lands.
    expect(fetchDeliverableBody).toHaveBeenCalledTimes(1);
  });

  it("renders an authenticated Download action for artifact rows", () => {
    const item = jsonItem({
      id: "dlv_log",
      name: "verifier-log",
      kind: "artifact",
      media_type: "text/plain",
      display_filename: "verifier.log",
      size_bytes: 1024,
      download_url: "/v1/agent-task-runs/run-1/deliverables/dlv_log",
    });
    render(<DeliverablesPanel items={[item]} />);
    const link = screen.getByLabelText("Download verifier-log");
    expect(link).toHaveAttribute("href", "/v1/agent-task-runs/run-1/deliverables/dlv_log");
    expect(link).toHaveAttribute("download", "verifier.log");
    expect(screen.getByText("text/plain")).toBeInTheDocument();
  });

  it("shows a loading indicator while the body is in flight", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchDeliverableBody).mockImplementation(
      () => new Promise(() => {}),
    );
    render(<DeliverablesPanel items={[jsonItem()]} />);

    await user.click(screen.getByLabelText("Toggle deliverable verdict"));
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });
});
