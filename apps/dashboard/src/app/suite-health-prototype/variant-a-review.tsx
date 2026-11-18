"use client";

// PROTOTYPE · variant A, second round (see NOTES.md for the research that
// reshaped it). One question, one metric, one action: tests that have not
// failed in the window, ranked by run count, each judged on its run cost.
// Follows the field's dominant shape (Launchable's "Never Failing Tests"):
// an advisory list, not a state machine. Run less / Keep are in-memory stubs.

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { taskDetailHref } from "@/lib/task-routes";
import {
  MIN_GRADED,
  failingSinceLabel,
  formatDollars,
  lastFailedLabel,
  shortModel,
  type TaskHealth,
} from "./health-data";

interface VariantProps {
  projectId: string;
  tasks: TaskHealth[];
  demo: boolean;
}

export default function VariantAReview({ projectId, tasks, demo }: VariantProps) {
  const [runLess, setRunLess] = useState<Set<string>>(new Set());
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (set: Set<string>, id: string) =>
    new Set(set.has(id) ? [...set].filter((x) => x !== id) : [...set, id]);

  // Advisory eligibility straight from the field's playbook: only tasks with
  // enough graded runs in the window are listed; the rest become a footnote.
  const eligible = tasks.filter((t) => t.graded >= MIN_GRADED);
  const neverFailing = eligible
    .filter((t) => t.failed === 0 && !kept.has(t.taskId))
    .sort((a, b) => b.graded - a.graded);
  const alwaysFailing = eligible.filter((t) => t.failStreak >= 8);
  const mixed = eligible.filter((t) => t.failed > 0 && t.failStreak < 8);
  const tooNew = tasks.filter((t) => t.graded < MIN_GRADED);
  const windowDays = neverFailing[0]?.windowDays ?? alwaysFailing[0]?.windowDays ?? null;

  const taskLink = (task: TaskHealth) =>
    demo ? (
      <span className="font-mono text-xs">{task.displayName}</span>
    ) : (
      <Link
        href={taskDetailHref(projectId, task.taskId)}
        className="font-mono text-xs hover:underline"
      >
        {task.displayName}
      </Link>
    );

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <h1 className="text-[18px] font-semibold tracking-tight">Suite Health</h1>
      <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
        A test that has not failed lately runs on every batch and proves
        nothing. Does it justify its run cost? Nothing below changes the suite
        automatically.
      </p>
      <p className="mt-3 font-mono text-xs tabular-nums">
        {neverFailing.length + kept.size} of {tasks.length} tests never failed
        {windowDays !== null ? ` in the last ${windowDays} days` : ""} ·{" "}
        {alwaysFailing.length} always failing · {mixed.length} failed at least once
      </p>

      {neverFailing.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold">Never Failed</h2>
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-[10px] text-muted-foreground">
                <th className="py-1.5 pr-3 w-6 font-medium" aria-label="Expand" />
                <th className="py-1.5 pr-3 font-medium">Test</th>
                <th className="py-1.5 pr-3 font-medium">Last Failed</th>
                <th className="py-1.5 pr-3 font-medium">Runs</th>
                <th className="py-1.5 pr-3 font-medium">Cost / Mo</th>
                <th className="py-1.5 font-medium" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {neverFailing.map((task) => {
                const isOpen = expanded.has(task.taskId);
                const runsLess = runLess.has(task.taskId);
                return (
                  <Fragment key={task.taskId}>
                    <tr
                      className={`border-b border-border/50 ${runsLess ? "opacity-60" : ""}`}
                    >
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          aria-label={isOpen ? "Collapse details" : "Expand details"}
                          aria-expanded={isOpen}
                          onClick={() => setExpanded(toggle(expanded, task.taskId))}
                          className="flex size-5 items-center justify-center text-muted-foreground hover:text-foreground"
                        >
                          <ChevronRight
                            className={`size-3 transition-transform ${isOpen ? "rotate-90" : ""}`}
                            aria-hidden
                          />
                        </button>
                      </td>
                      <td className="py-2 pr-3">{taskLink(task)}</td>
                      <td className="py-2 pr-3 font-mono tabular-nums text-warning">
                        {lastFailedLabel(task)}
                        {runsLess && (
                          <span className="ml-2 text-[10px] text-muted-foreground">
                            runs less (stub)
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 font-mono tabular-nums">{task.graded}</td>
                      <td className="py-2 pr-3 font-mono tabular-nums">
                        {formatDollars(task.costPerMonth)}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <Button
                          type="button"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          onClick={() => setRunLess(toggle(runLess, task.taskId))}
                        >
                          {runsLess ? "Undo" : "Run less"}
                        </Button>{" "}
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-7 px-2 text-xs text-muted-foreground"
                          onClick={() => setKept(toggle(kept, task.taskId))}
                        >
                          Keep
                        </Button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-border/50">
                        <td />
                        <td colSpan={5} className="py-2 pb-3 text-[11px] text-muted-foreground">
                          <span className="font-mono">
                            {task.facets
                              .map((f) => `${shortModel(f.model)} ${f.passed}/${f.graded}`)
                              .join(" · ") || "no model facets"}
                          </span>
                          <span className="mt-1 block">
                            Run less keeps the test in the suite and backs off its
                            scheduled cadence. Manual runs, history, and stats stay
                            untouched.
                          </span>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {kept.size > 0 && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Kept as a deliberate guard: {kept.size} (stub; a real Keep would
              snooze the listing for 30 days).
            </p>
          )}
        </section>
      )}

      {alwaysFailing.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold">Always Failing</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Not removal candidates. Inspect the test or accept it as known-hard.
          </p>
          <table className="mt-2 w-full text-xs">
            <tbody>
              {alwaysFailing.map((task) => (
                <tr key={task.taskId} className="border-b border-border/50">
                  <td className="py-2 pr-4 w-56">{taskLink(task)}</td>
                  <td className="py-2 pr-4 font-mono tabular-nums text-destructive whitespace-nowrap">
                    failing {failingSinceLabel(task)}
                  </td>
                  <td className="py-2 font-mono text-[11px] tabular-nums text-muted-foreground">
                    {task.facets
                      .map((f) => `${shortModel(f.model)} ${f.passed}/${f.graded}`)
                      .join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <p className="mt-8 text-[11px] text-muted-foreground">
        {tooNew.length > 0
          ? `${tooNew.length} test${tooNew.length === 1 ? "" : "s"} not listed yet (under ${MIN_GRADED} runs). `
          : ""}
        Buttons are in-memory stubs; nothing here writes to the server.
      </p>
    </div>
  );
}
