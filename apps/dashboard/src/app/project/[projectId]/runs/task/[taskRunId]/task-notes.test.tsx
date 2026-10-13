/**
 * Scene tests: Task Notes on the run page, read-only.
 *
 * 1. notesForRun splits Folder/Task Notes from Test Notes keyed by test id.
 * 2. The notes rail: a one-line summary in the flow, a right-edge chip, and
 *    a drawer grouping every Note (Folder / Task / per test) with scope
 *    label, attribution, the "Different task revision" marker, and
 *    plain-text bodies. Escape and the backdrop close it.
 * 3. capTestNotes keeps the newest Note per Test inline; the rest surface as
 *    an overflow count behind the "+N more" line, which opens the drawer.
 * 4. No Notes (absent or empty) → nothing renders.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";

vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: (_loader: () => Promise<unknown>) => {
    const Comp = () => null;
    Comp.displayName = "DynamicComponent";
    return Comp;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

import type { CheckResult, TaskNote } from "@/lib/agent-task-api";
import { ChecksList } from "./checks-list";
import { ExpandableCheckItem } from "./expandable-check-item";
import { TaskNotesRail, TestNotes } from "./task-notes";
import { capTestNotes, noteAttribution, notesForRun } from "./task-notes-model";

function note(overrides: Partial<TaskNote> = {}): TaskNote {
  return {
    id: "note_0000000000000001",
    scope: "task",
    folder: null,
    task_id: "harvey-lab/assess-risk",
    test_id: null,
    body: "Opus 5.5 normally scores 45–47/48",
    task_definition_revision_id: "rev_1",
    created_by_user_id: "u1",
    created_by_label: "sami",
    created_via: "session",
    created_at: "2026-10-10T09:00:00Z",
    updated_by_user_id: "u1",
    updated_by_label: "sami",
    updated_via: "session",
    updated_at: "2026-10-12T09:00:00Z",
    archived_at: null,
    task_definition_revision_matches_run: true,
    ...overrides,
  };
}

const folderNote = note({
  id: "note_folder",
  scope: "folder",
  folder: "harvey-lab",
  task_id: null,
  task_definition_revision_id: null,
  body: "DeepSeek judge returns FAIL under PASS reasoning\nabout 1 draw in 5",
  created_by_label: "ci-agent",
  updated_by_label: "ci-agent",
  updated_at: "2026-10-01T00:00:00Z",
});
const taskNote = note({ id: "note_task", task_definition_revision_matches_run: false });
const testNote = note({
  id: "note_test",
  scope: "test",
  test_id: "C-021",
  body: "Audited 2026-10-12: criterion sound, misses are real",
});

function check(overrides: Partial<CheckResult> = {}): CheckResult {
  return { id: "C-021", pass: true, reasoning: "covered", ...overrides };
}

describe("notesForRun", () => {
  it("splits Folder/Task Notes from Test Notes keyed by test id", () => {
    const { general, byTest } = notesForRun([folderNote, taskNote, testNote]);
    expect(general.map((n) => n.id)).toEqual(["note_folder", "note_task"]);
    expect([...byTest.keys()]).toEqual(["C-021"]);
    expect(byTest.get("C-021")?.map((n) => n.id)).toEqual(["note_test"]);
  });

  it("treats a missing list as no Notes", () => {
    const { general, byTest } = notesForRun(undefined);
    expect(general).toEqual([]);
    expect(byTest.size).toBe(0);
  });
});

describe("noteAttribution", () => {
  it("distinguishes the creator from the editor of the current text", () => {
    expect(
      noteAttribution(
        note({ updated_by_user_id: "u2", updated_by_label: "alex", updated_via: "session" }),
      ),
    ).toBe("created by sami · updated by alex · 2026-10-12");
  });
});

/** Drives the rail's controlled open state the way the run page does. */
function RailHarness({
  notes,
  checks,
}: {
  notes: TaskNote[];
  checks: CheckResult[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <TaskNotesRail notes={notes} checks={checks} open={open} onOpenChange={setOpen} />
  );
}

describe("TaskNotesRail", () => {
  it("summarizes in the flow and groups every Note in the drawer", () => {
    render(
      <RailHarness
        notes={[folderNote, taskNote, testNote]}
        checks={[check({ pass: false })]}
      />,
    );

    // The flow keeps one line; the failing count points at the red checks.
    expect(
      screen.getByRole("button", { name: /3 notes on this task/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 on failing checks/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open task notes" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /3 notes on this task/ }));
    const drawer = screen.getByRole("dialog");

    expect(drawer).toHaveTextContent("harvey-lab");
    expect(drawer).toHaveTextContent("ci-agent · 2026-10-01");
    expect(drawer).toHaveTextContent("Task");
    expect(drawer).toHaveTextContent("sami · 2026-10-12");
    expect(drawer).toHaveTextContent("C-021");
    expect(screen.getAllByText("Different task revision")).toHaveLength(1);

    // Plain text with line breaks kept, not rendered markup.
    const body = screen.getByText(/DeepSeek judge returns FAIL/);
    expect(body.textContent).toBe(folderNote.body);
    expect(body.className).toContain("whitespace-pre-wrap");
  });

  it("closes on Escape and via the close button", () => {
    render(<RailHarness notes={[taskNote]} checks={[check()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Open task notes" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open task notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the body as text, never as HTML", () => {
    const { container } = render(
      <TaskNotesRail
        notes={[note({ body: "<b>bold</b> **md**" })]}
        checks={[]}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("<b>bold</b> **md**")).toBeInTheDocument();
  });

  it("renders nothing without Notes", () => {
    const { container } = render(
      <TaskNotesRail notes={[]} checks={[check()]} open onOpenChange={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("capTestNotes", () => {
  it("keeps the newest Note inline and counts the rest as overflow", () => {
    const older = note({
      id: "note_older",
      scope: "test",
      test_id: "C-021",
      updated_at: "2026-10-01T00:00:00Z",
    });
    const byTest = notesForRun([testNote, older]).byTest;
    const { capped, overflow } = capTestNotes(byTest);

    expect(capped.get("C-021")?.map((n) => n.id)).toEqual(["note_test"]);
    expect(overflow.get("C-021")).toBe(1);
  });

  it("reports no overflow under the limit", () => {
    const { capped, overflow } = capTestNotes(notesForRun([testNote]).byTest);
    expect(capped.get("C-021")).toHaveLength(1);
    expect(overflow.size).toBe(0);
  });
});

describe("Test Notes overflow line", () => {
  it("links the remaining Notes to the drawer", () => {
    const onOpenNotes = vi.fn();
    render(
      <TestNotes notes={[testNote]} moreCount={2} onOpenNotes={onOpenNotes} />,
    );
    const more = screen.getByRole("button", { name: /2 more notes/ });
    fireEvent.click(more);
    expect(onOpenNotes).toHaveBeenCalledTimes(1);
  });

  it("stays quiet without overflow", () => {
    render(<TestNotes notes={[testNote]} />);
    expect(screen.queryByRole("button", { name: /more notes/ })).toBeNull();
  });
});

describe("Test Notes in a check", () => {
  it("marks a passing check's row and shows the Note when expanded", () => {
    render(<ExpandableCheckItem item={check()} index={0} notes={[testNote]} />);
    expect(screen.getByText("Note")).toHaveAttribute("title", testNote.body);
    expect(screen.queryByRole("list", { name: "Test notes" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /C-021/ }));
    const notes = screen.getByRole("list", { name: "Test notes" });
    expect(notes).toHaveTextContent(testNote.body);
    expect(notes).toHaveTextContent("sami · 2026-10-12");
  });

  it("routes each Test's Notes to its own check in the list", () => {
    const { byTest } = notesForRun([folderNote, testNote]);
    render(
      <ChecksList
        checks={[check(), check({ id: "C-022", pass: false, reasoning: "missed" })]}
        testNotes={byTest}
      />,
    );
    expect(screen.getAllByText("Note")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /C-022/ }));
    expect(screen.queryByRole("list", { name: "Test notes" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /C-021/ }));
    expect(screen.getByRole("list", { name: "Test notes" })).toHaveTextContent(testNote.body);
  });

  it("renders no Note affordance on a check without Notes", () => {
    render(<ExpandableCheckItem item={check()} index={0} />);
    expect(screen.queryByText("Note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /C-021/ }));
    expect(screen.queryByRole("list", { name: "Test notes" })).toBeNull();
  });
});
