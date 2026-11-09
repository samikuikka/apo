/**
 * The run dialog's labels editor: free key/value entry with the backend's
 * exact shape and limits, suggestions from the project's existing values, and
 * chips that can be removed before the run starts.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RunLabelsDialog } from "@/app/project/[projectId]/tasks/components/RunLabelsDialog";
import { fetchRunLabelFacets } from "@/lib/agent-task-api";

vi.mock("@/lib/agent-task-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-task-api")>(
    "@/lib/agent-task-api",
  );
  return {
    ...actual,
    fetchRunLabelFacets: vi.fn(),
  };
});

function renderDialog(onStart = vi.fn()) {
  render(
    <RunLabelsDialog
      open
      onOpenChange={vi.fn()}
      projectId="acme"
      selectedCount={2}
      running={false}
      onStart={onStart}
    />,
  );
  return onStart;
}

beforeEach(() => {
  vi.mocked(fetchRunLabelFacets).mockResolvedValue({
    environments: [{ value: "prod", count: 4 }],
    labels: [
      {
        key: "team",
        values: [
          { id: "platforms", name: "platforms", count: 3 },
          { id: "ml", name: "ml", count: 2 },
        ],
      },
    ],
  });
});

describe("RunLabelsDialog", () => {
  it("starts with no labels and sends an empty set", async () => {
    const onStart = renderDialog();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(withinDialogRunButton(dialog));
    expect(onStart).toHaveBeenCalledWith({});
  });

  it("adds a label as key plus id/name value and forwards it on start", async () => {
    const user = userEvent.setup();
    const onStart = renderDialog();
    await user.type(screen.getByLabelText("Label key"), "customer");
    await user.type(screen.getByLabelText("Label value"), "acme");
    fireEvent.click(screen.getByRole("button", { name: "Add Label" }));

    expect(screen.getByRole("button", { name: "Remove customer acme" })).toBeInTheDocument();
    fireEvent.click(withinDialogRunButton(screen.getByRole("dialog")));
    expect(onStart).toHaveBeenCalledWith({
      customer: { id: "acme", name: "acme" },
    });
  });

  it("rejects keys the backend would 422", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Label key"), { target: { value: "my key!" } });
    fireEvent.change(screen.getByLabelText("Label value"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Label" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Keys use letters/i);
    expect(screen.queryByRole("button", { name: /Remove / })).toBeNull();
  });

  it("rejects a second value under the same key", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Label key"), { target: { value: "team" } });
    fireEvent.change(screen.getByLabelText("Label value"), { target: { value: "platforms" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Label" }));
    // Adding clears both fields, so the second attempt retypes the key.
    fireEvent.change(screen.getByLabelText("Label key"), { target: { value: "team" } });
    fireEvent.change(screen.getByLabelText("Label value"), { target: { value: "ml" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Label" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/already has a value/i);
  });

  it("adds a suggestion with the facet's own id, not a retyped name", async () => {
    vi.mocked(fetchRunLabelFacets).mockResolvedValue({
      environments: [],
      labels: [
        {
          key: "customer",
          // id and name differ: committing the name as a new id would
          // fork the dimension the suggestion exists to reuse.
          values: [{ id: "c-2", name: "Globex", count: 3 }],
        },
      ],
    });
    const onStart = renderDialog();
    fireEvent.change(screen.getByLabelText("Label key"), { target: { value: "customer" } });
    await waitFor(() => {
      expect(screen.getByText("Used for customer:")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Globex" }));
    expect(screen.getByRole("button", { name: "Remove customer Globex" })).toBeInTheDocument();
    fireEvent.click(withinDialogRunButton(screen.getByRole("dialog")));
    expect(onStart).toHaveBeenCalledWith({ customer: { id: "c-2", name: "Globex" } });
  });

  it("a reopened dialog starts from a clean draft", () => {
    const onStart = vi.fn();
    const props = {
      onOpenChange: vi.fn(),
      projectId: "acme",
      selectedCount: 2,
      running: false,
      onStart,
    };
    const { rerender } = render(<RunLabelsDialog open {...props} />);
    fireEvent.change(screen.getByLabelText("Label key"), { target: { value: "team" } });
    fireEvent.change(screen.getByLabelText("Label value"), { target: { value: "platforms" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Label" }));
    expect(screen.getByRole("button", { name: "Remove team platforms" })).toBeInTheDocument();

    rerender(<RunLabelsDialog open={false} {...props} />);
    rerender(<RunLabelsDialog open {...props} />);

    expect(screen.queryByRole("button", { name: "Remove team platforms" })).toBeNull();
    fireEvent.click(withinDialogRunButton(screen.getByRole("dialog")));
    expect(onStart).toHaveBeenCalledWith({});
  });

  it("Enter in the value field adds the label", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Label key"), { target: { value: "team" } });
    fireEvent.change(screen.getByLabelText("Label value"), { target: { value: "platforms" } });
    fireEvent.keyDown(screen.getByLabelText("Label value"), { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove team platforms" })).toBeInTheDocument();
  });

  it("a removed label is not forwarded", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Label key"), { target: { value: "team" } });
    fireEvent.change(screen.getByLabelText("Label value"), { target: { value: "platforms" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Label" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove team platforms" }));
    fireEvent.click(withinDialogRunButton(screen.getByRole("dialog")));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

function withinDialogRunButton(dialog: HTMLElement) {
  return within(dialog).getByRole("button", { name: "Run 2 tasks" });
}
