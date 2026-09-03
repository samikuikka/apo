import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { TraceDetailTabs } from "../TraceDetailTabs";
import { SelectionProvider } from "../contexts/SelectionContext";

function renderTabs(run: any) {
  return render(
    <SelectionProvider>
      <TraceDetailTabs run={run} />
    </SelectionProvider>,
  );
}

const BASE_RUN = {
  id: "run-1",
  project: "p1",
  input: null,
  output: null,
  created_at: "2026-01-01T00:00:00Z",
};

describe("TraceDetailTabs preview empty states", () => {
  it("shows the no-data message when trace and call I/O are all empty objects", () => {
    // Raw-OTel traces record `input: {}` on their spans; rendering those as an
    // empty JSON tree looks like a broken pane, so they count as absent.
    renderTabs({
      run: { ...BASE_RUN },
      calls: [
        { id: "c1", input: {}, output: {} },
        { id: "c2", input: {}, output: {} },
      ],
    });
    expect(screen.getByText("No input recorded for this trace.")).toBeTruthy();
    expect(screen.getByText("No output recorded for this trace.")).toBeTruthy();
  });

  it("falls back to the first call's payload when the trace has none", () => {
    renderTabs({
      run: { ...BASE_RUN },
      calls: [{ id: "c1", input: { query: "select 1" }, output: { rows: 3 } }],
    });
    expect(screen.queryByText("No input recorded for this trace.")).toBeNull();
    expect(screen.getByText("Query")).toBeTruthy();
    expect(screen.getByText("Rows")).toBeTruthy();
  });

  it("renders a recorded trace-level input and output as-is", () => {
    renderTabs({
      run: { ...BASE_RUN, input: { prompt: "hello" }, output: { answer: "hi" } },
      calls: [{ id: "c1", input: { ignored: true }, output: { ignored: true } }],
    });
    expect(screen.getByText("Prompt")).toBeTruthy();
    expect(screen.getByText("Answer")).toBeTruthy();
    expect(screen.queryByText("No input recorded for this trace.")).toBeNull();
    expect(screen.queryByText("No output recorded for this trace.")).toBeNull();
  });
});
