"use client";

import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCostMicro } from "@/lib/format";

/**
 * Collapsible header for one `describe()` group of checks.
 * Presentational only — the parent owns open/closed state and renders the
 * member checks. Mirrors the compare view's FlowSection header: chevron +
 * name + passed/total tally + pass bar + aggregate cost + verdict dot.
 *
 * Per the design discussion: starts expanded, click-to-toggle, no auto-collapse
 * logic. A group is green when every member passes, red otherwise.
 */
export function CheckGroupHeader({
  groupName,
  passed,
  total,
  cost,
  open,
  onToggle,
  splitCount = 0,
}: {
  groupName: string;
  passed: number;
  total: number;
  cost: number;
  open: boolean;
  onToggle: () => void;
  /** Checks in this group where the second judge's verdict differs. */
  splitCount?: number;
}) {
  const failed = total - passed;
  const allPass = failed === 0;
  const rate = total > 0 ? (passed / total) * 100 : 0;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? `Collapse ${groupName}` : `Expand ${groupName}`}
      className="flex w-full items-center gap-3 bg-card/30 px-4 py-2.5 text-left transition-colors hover:bg-card/40"
    >
      <span
        className={cn(
          "shrink-0 text-muted-foreground/60 transition-transform",
          open && "rotate-90",
        )}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </span>
      <span
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          allPass ? "bg-success" : "bg-destructive",
        )}
      />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
        {groupName}
      </span>
      <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground">
        <span className={cn(allPass ? "text-success" : "text-foreground")}>
          {passed}
        </span>
        <span className="text-muted-foreground/60">/{total}</span>
        {splitCount > 0 && (
          <span
            className="ml-2 text-warning"
            title={`${splitCount} check${splitCount === 1 ? "" : "s"} where the judges' verdicts differ`}
          >
            ⇄ {splitCount}
          </span>
        )}
      </span>
      <div className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-border">
        <div
          className={cn(
            "h-full",
            allPass ? "bg-success" : "bg-destructive",
          )}
          style={{ width: `${rate}%` }}
        />
      </div>
      {cost > 0 && (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {formatCostMicro(cost)}
        </span>
      )}
    </button>
  );
}
