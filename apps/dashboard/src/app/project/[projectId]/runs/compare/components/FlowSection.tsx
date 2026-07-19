"use client";

import { useState } from "react";
import { ChevronRight, Folder } from "lucide-react";

import { cn } from "@/lib/utils";

import { type CheckTally, type ComparisonTask } from "../use-comparison";
import { CompareTaskRow } from "./CompareTaskRow";

interface FlowSectionProps {
  folder: string;
  tasks: ComparisonTask[];
  differsCount: number;
  /** Σ checks across the folder's runs, per side. Graded signal (belief #5):
   *  surfaces a per-flow regression even when every task failed on both
   *  sides. Omitted when neither side recorded checks. */
  leftChecks: CheckTally;
  rightChecks: CheckTally;
  defaultOpen: boolean;
  expanded: Set<string>;
  onToggleExpand: (value: string, open?: boolean) => void;
  projectId: string;
}

/**
 * One flow (folder) in the Flows view. Collapsible section whose header
 * carries a *fact* count of differing tasks — never a verdict about
 * direction. Worst-status-wins: a folder with any differing task is
 * visually marked so a change can't hide behind an all-green section.
 */
export function FlowSection({
  folder,
  tasks,
  differsCount,
  leftChecks,
  rightChecks,
  defaultOpen,
  expanded,
  onToggleExpand,
  projectId,
}: FlowSectionProps) {
  const [forcedOpen, setForcedOpen] = useState<boolean | null>(null);
  // Controlled-by-default-open unless the user has toggled manually.
  const isOpen = forcedOpen ?? defaultOpen;

  // A differing task marks the whole flow. We do not assert which way.
  const hasChange = differsCount > 0;
  // Graded signal — only meaningful when at least one side ran checks.
  const hasChecks = leftChecks.total > 0 || rightChecks.total > 0;
  const delta = rightChecks.passed - leftChecks.passed;

  return (
    <div className="py-1">
      <div className="flex items-center gap-2 px-6 py-2">
        <button
          type="button"
          onClick={() => setForcedOpen(!isOpen)}
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={isOpen ? "Collapse" : "Expand"}
        >
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-90")} />
        </button>
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-[14px] font-medium text-foreground">{folder || "(root)"}</span>
        <span className="rounded bg-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          {tasks.length} task{tasks.length === 1 ? "" : "s"}
        </span>
        {hasChange && (
          <span className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-foreground">
            {differsCount} differ{differsCount === 1 ? "" : "s"}
          </span>
        )}
        {hasChecks && (
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            · checks {leftChecks.passed}/{leftChecks.total}
            <span className="text-muted-foreground/40"> → </span>
            {rightChecks.passed}/{rightChecks.total}
            {delta !== 0 && (
              <span className={cn("ml-0.5", delta > 0 ? "text-success" : "text-destructive")}>
                ({delta > 0 ? "+" : ""}
                {delta})
              </span>
            )}
          </span>
        )}
      </div>

      {isOpen && (
        <div className="mt-0.5 divide-y divide-border/60">
          {tasks.map((task) => (
            <CompareTaskRow
              key={task.taskId}
              task={task}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              projectId={projectId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
