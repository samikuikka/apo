/**
 * Pure model for Task Notes on the run page. Mirrors the CLI's
 * `notesForRun` (packages/cli/src/lib/task-notes.ts) so a Note sits in the
 * same place in `apo runs show` and here. Kept free of "use client".
 */
import type { TaskNote } from "@/lib/agent-task-api";

export interface NotesForRun {
  /** Folder and Task Notes, summarized by the notes rail's one-liner. */
  general: TaskNote[];
  /** Test Notes keyed by test id (the check's `id`). */
  byTest: Map<string, TaskNote[]>;
}

export function notesForRun(notes: ReadonlyArray<TaskNote> | null | undefined): NotesForRun {
  const general: TaskNote[] = [];
  const byTest = new Map<string, TaskNote[]>();
  for (const note of notes ?? []) {
    if (note.scope === "test") {
      if (!note.test_id) continue;
      byTest.set(note.test_id, [...(byTest.get(note.test_id) ?? []), note]);
    } else {
      general.push(note);
    }
  }
  return { general, byTest };
}

/** Inline rendering keeps the newest Note per Test; the rest live in the rail. */
export interface CappedTestNotes {
  capped: Map<string, TaskNote[]>;
  /** How many Notes per test id sit behind the "+N more" line. */
  overflow: Map<string, number>;
}

export function capTestNotes(
  byTest: ReadonlyMap<string, TaskNote[]>,
  limit = 1,
): CappedTestNotes {
  const capped = new Map<string, TaskNote[]>();
  const overflow = new Map<string, number>();
  for (const [testId, notes] of byTest) {
    const sorted = notes.toSorted(byNewest);
    capped.set(testId, sorted.slice(0, limit));
    if (sorted.length > limit) overflow.set(testId, sorted.length - limit);
  }
  return { capped, overflow };
}

/** Newest-first by last edit; Notes without a timestamp sort last. */
export function byNewest(a: TaskNote, b: TaskNote): number {
  return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
}

/** Where a general Note sits: the Folder path, or "Task". */
export function noteScopeLabel(note: TaskNote): string {
  if (note.scope === "folder") return note.folder ?? "Folder";
  if (note.scope === "task") return "Task";
  return "Test";
}

/** Who created and last edited it, followed by the last-change date. */
export function noteAttribution(note: TaskNote): string {
  const creator = note.created_by_label ?? note.created_by_user_id ?? note.created_via;
  const updater = note.updated_by_label ?? note.updated_by_user_id ?? note.updated_via;
  const attribution = creator === updater ? creator : `created by ${creator} · updated by ${updater}`;
  return `${attribution} · ${note.updated_at.slice(0, 10)}`;
}
