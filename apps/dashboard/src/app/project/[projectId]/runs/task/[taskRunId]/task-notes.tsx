"use client";

import { StickyNote } from "lucide-react";
import type { CheckResult, TaskNote } from "@/lib/agent-task-api";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { noteAttribution, noteScopeLabel, notesForRun, byNewest } from "./task-notes-model";

/**
 * Task Notes, read-only. A Note is knowledge, not a verdict, so it stays
 * gray — only the "Different task revision" marker takes the warning tone,
 * because it qualifies whether the Note still holds. Bodies are plain text
 * with line breaks preserved, never parsed as markup.
 *
 * Placement: the page flow carries only a one-line summary; a slim rail on
 * the right edge opens a drawer with every Note that applies to the task,
 * grouped Folder / Task / per test; and a Test keeps its newest Note inline
 * at the point of failure, the rest behind a "+N more" line that opens the
 * drawer. The checks stay scannable no matter how many Notes a task gathers.
 */

/** The in-flow summary line plus the right-edge rail that opens the drawer. */
export function TaskNotesRail({
  notes,
  checks,
  open,
  onOpenChange,
}: {
  notes: TaskNote[];
  checks: CheckResult[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (notes.length === 0) return null;

  const failingIds = new Set(
    checks.filter((c) => c.pass !== true).map((c) => String(c.id ?? "")),
  );
  const onFailing = notes.filter(
    (n) => n.scope === "test" && failingIds.has(n.test_id ?? ""),
  ).length;

  return (
    <>
      <p className="text-[12px] text-muted-foreground">
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          className="inline-flex items-center gap-1.5 underline-offset-2 hover:text-foreground hover:underline"
        >
          <StickyNote className="h-3 w-3" aria-hidden />
          {notes.length} note{notes.length === 1 ? "" : "s"} on this task
        </button>
        {onFailing > 0 && (
          <span className="text-muted-foreground/70">
            {" "}
            · {onFailing} on failing checks
          </span>
        )}
      </p>

      <button
        type="button"
        onClick={() => onOpenChange(true)}
        aria-label="Open task notes"
        className="fixed right-0 top-1/2 z-40 -translate-y-1/2 border-y border-l border-border bg-card px-1.5 py-3 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        style={{ writingMode: "vertical-rl" }}
      >
        <span className="flex items-center gap-2">
          <StickyNote className="h-3 w-3 rotate-90" aria-hidden />
          Notes {notes.length}
        </span>
      </button>

      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="w-full p-0 sm:w-[400px]"
          aria-label="Task notes"
        >
          <SheetHeader className="shrink-0 border-b px-4 py-3">
            <SheetTitle className="text-sm">
              Notes
              <span className="ml-1.5 text-muted-foreground">({notes.length})</span>
            </SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4">
            <NotesSurface notes={notes} checks={checks} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Grouped read of every Note that applies to the task. */
function NotesSurface({ notes, checks }: { notes: TaskNote[]; checks: CheckResult[] }) {
  const { general, byTest } = notesForRun(notes);
  const folders = general.filter((n) => n.scope === "folder").toSorted(byNewest);
  const tasks = general.filter((n) => n.scope === "task").toSorted(byNewest);
  const passById = new Map(checks.map((c) => [String(c.id ?? ""), c.pass === true]));

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-muted-foreground">
        Durable knowledge about this task — folder, task, and per-test notes.
        Nothing here changes a verdict.
      </p>
      {folders.length > 0 && (
        <NotesGroup title="Folder" notes={folders} labelFor={noteScopeLabel} />
      )}
      {tasks.length > 0 && <NotesGroup title="Task" notes={tasks} labelFor={() => "Task"} />}
      {Array.from(byTest.keys()).toSorted().map((testId) => {
        const list = (byTest.get(testId) ?? []).toSorted(byNewest);
        const pass = passById.get(testId);
        return (
          <section key={testId} className="border border-border bg-card/60 px-4 py-3">
            <h3 className="flex items-baseline gap-2">
              <span className="font-mono text-[12px] text-foreground">{testId}</span>
              <span
                className={cn(
                  "text-[10px] uppercase tracking-wide",
                  pass === true
                    ? "text-success"
                    : pass === false
                      ? "text-destructive"
                      : "text-muted-foreground/60",
                )}
              >
                {pass === true ? "pass" : pass === false ? "fail" : "—"}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground/60">
                {list.length} note{list.length === 1 ? "" : "s"}
              </span>
            </h3>
            <ul className="mt-2 space-y-2">
              {list.map((note) => (
                <li key={note.id}>
                  <NoteEntry note={note} label="Note" />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function NotesGroup({
  title,
  notes,
  labelFor,
}: {
  title: string;
  notes: TaskNote[];
  labelFor: (note: TaskNote) => string;
}) {
  return (
    <section className="border border-border bg-card/60 px-4 py-3">
      <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
        {title} <span className="font-mono normal-case">{notes.length}</span>
      </h3>
      <ul className="mt-2 space-y-2">
        {notes.map((note) => (
          <li key={note.id}>
            <NoteEntry note={note} label={labelFor(note)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A Test's Notes inside its expanded check — the newest inline, the rest behind "+N more". */
export function TestNotes({
  notes,
  moreCount = 0,
  onOpenNotes,
}: {
  notes: TaskNote[];
  moreCount?: number;
  onOpenNotes?: () => void;
}) {
  if (notes.length === 0 && moreCount === 0) return null;
  return (
    <ul aria-label="Test notes" className="space-y-1.5">
      {notes.map((note) => (
        <li key={note.id}>
          <NoteEntry note={note} label="Note" />
        </li>
      ))}
      {moreCount > 0 && onOpenNotes && (
        <li>
          <button
            type="button"
            onClick={onOpenNotes}
            className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            +{moreCount} more note{moreCount === 1 ? "" : "s"} — Notes
          </button>
        </li>
      )}
    </ul>
  );
}

function NoteEntry({ note, label }: { note: TaskNote; label: string }) {
  return (
    <div className="text-[12px]">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-foreground">{label}</span>
        <span className="text-muted-foreground">{noteAttribution(note)}</span>
        {note.task_definition_revision_matches_run === false && (
          <span
            className="border border-warning/40 bg-warning/10 px-1.5 py-px text-[10px] font-medium text-warning"
            title="This Note was written against a different Task Definition Revision than this run used"
          >
            Different task revision
          </span>
        )}
      </p>
      <p className="mt-0.5 whitespace-pre-wrap break-words border-l-2 border-border pl-2.5 text-[13px] leading-relaxed text-foreground/80">
        {note.body}
      </p>
    </div>
  );
}
