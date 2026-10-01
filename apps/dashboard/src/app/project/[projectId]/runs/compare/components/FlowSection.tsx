"use client";

import { useState } from "react";
import { ChevronRight, Folder } from "lucide-react";

import { cn } from "@/lib/utils";
import type { TaskComparisonEvidenceLoader } from "@/lib/agent-task-view-api";

import { type ComparisonTask } from "../use-comparison";
import { CompareTaskRow } from "./CompareTaskRow";

interface FlowSectionProps {
  folder: string;
  tasks: ComparisonTask[];
  differsCount: number;
  defaultOpen: boolean;
  expanded: Set<string>;
  onToggleExpand: (value: string, open?: boolean) => void;
  projectId: string;
  /** Optional progressive evidence loader. When provided,
   *  CompareTaskRow fetches full details lazily on expand instead of
   *  receiving them in bulk from SSR. */
  evidenceLoader?: TaskComparisonEvidenceLoader;
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
  defaultOpen,
  expanded,
  onToggleExpand,
  projectId,
  evidenceLoader,
}: FlowSectionProps) {
  const [forcedOpen, setForcedOpen] = useState<boolean | null>(null);
  // Controlled-by-default-open unless the user has toggled manually.
  const isOpen = forcedOpen ?? defaultOpen;

  // A differing task marks the whole flow. We do not assert which way.
  const hasChange = differsCount > 0;

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
          <span
            className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-foreground"
            title="tasks whose results changed between the two runs"
          >
            {differsCount} changed
          </span>
        )}
      </div>

      {/* Tasks indent one level under the folder header (their px-6 content
          lands beneath the folder name) so parent/child reads as a tree —
          mirrors the task picker's folder-row → pl-10 step. */}
      {isOpen && (
        <div className="mt-0.5 ml-12 divide-y divide-border/60">
          {tasks.map((task) => (
            <CompareTaskRow
              key={task.taskId}
              task={task}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              projectId={projectId}
              evidenceLoader={evidenceLoader}
            />
          ))}
        </div>
      )}
    </div>
  );
}
