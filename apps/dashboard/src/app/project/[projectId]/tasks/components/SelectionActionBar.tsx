"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, GitCompare, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import type { ExecutorRunWarning } from "./executor-run-warning";

export function SelectionActionBar({
  selectedCount,
  runRunning,
  comparing,
  isDemoProject,
  canRunTasks = true,
  runWarning = null,
  compareOptions,
  onClear,
  onRun,
  onCompare,
}: {
  selectedCount: number;
  runRunning: boolean;
  comparing: boolean;
  isDemoProject: boolean;
  /** Hide write actions for read-only visitors. */
  canRunTasks?: boolean;
  /** Why a run would sit unclaimed in the queue; merged into the bar's top edge. */
  runWarning?: ExecutorRunWarning | null;
  compareOptions: { model: string | null; label: string }[];
  onClear: () => void;
  onRun: () => void;
  onCompare: (bModel: string | null) => void;
}) {
  const [whyOpen, setWhyOpen] = useState(false);
  const showWarning = canRunTasks && !isDemoProject && runWarning !== null;
  // An open disclosure belongs to the warning it explained; a changed or
  // cleared warning starts closed.
  useEffect(() => {
    setWhyOpen(false);
  }, [runWarning?.label]);

  return (
    <div className="sticky bottom-4 z-20 mx-auto mb-4 w-fit max-w-[calc(100%-1rem)]">
      {/* The live region stays mounted so its content changes are announced;
          screen readers get the full sentences, the bar shows the strip. */}
      <div role="status" className="sr-only">
        {showWarning && runWarning
          ? `${runWarning.label} — ${runWarning.fix}. ${runWarning.detail}`
          : null}
      </div>
      {/* One bordered unit: the warning is the bar's top edge, never a
          separate floating card over the task list. */}
      <div className="border border-border bg-card shadow-2xl shadow-black/60">
        {showWarning && runWarning && (
          <div data-testid="executor-run-warning">
            <div className="flex items-center gap-2 px-3 pt-2 text-[12px]">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
              <p className="min-w-0 truncate font-medium text-foreground">
                {runWarning.label}
                <span className="font-normal text-muted-foreground"> — {runWarning.fix}</span>
              </p>
              <button
                type="button"
                aria-expanded={whyOpen}
                onClick={() => setWhyOpen((open) => !open)}
                className="ml-auto shrink-0 text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                Why?
              </button>
            </div>
            {whyOpen && (
              <p className="px-3 pb-2 pl-[34px] text-[12px] leading-relaxed text-muted-foreground">
                {runWarning.detail}
              </p>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 px-3 py-2">
        <div className="flex items-center gap-2 text-[12px]">
          <span className="grid h-5 min-w-5 place-items-center bg-white px-1 font-mono text-[11px] font-semibold text-black">
            {selectedCount}
          </span>
          <span className="text-muted-foreground">
            task{selectedCount > 1 ? "s" : ""} selected
          </span>
        </div>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[12px] font-normal text-muted-foreground hover:text-foreground/70" onClick={onClear}>
          Clear
        </Button>
        {canRunTasks ? (
          <Button type="button" size="sm" className="h-7 gap-1.5 px-3 text-[12px] font-medium" onClick={onRun} disabled={runRunning || isDemoProject} title={isDemoProject ? "Demo workspace is read-only" : undefined}>
            <Play className="h-3 w-3 fill-current" />
            {runRunning ? "Starting..." : "Run selection"}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="sm"
              className="h-7 gap-1 px-3 text-[12px] font-medium"
              disabled={comparing || isDemoProject || compareOptions.length === 0}
              title={isDemoProject ? "Demo workspace is read-only" : "Compare the selection against another view"}
            >
              <GitCompare className="h-3 w-3" />
              {comparing ? "Building…" : "Compare"}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[200px]">
            <p className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-foreground/60">
              Compare against
            </p>
            {compareOptions.map((opt) => (
              <DropdownMenuItem
                key={opt.model ?? "__all__"}
                onClick={() => onCompare(opt.model)}
                className="text-[13px] text-foreground/80"
              >
                {opt.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
