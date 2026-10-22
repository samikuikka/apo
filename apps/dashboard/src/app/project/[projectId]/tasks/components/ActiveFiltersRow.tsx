"use client";

/**
 * One removable chip per filter value currently narrowing the tasks list,
 * plus a "Clear all" escape hatch. The caller (EvidenceViewsBar) derives
 * the chip list; this component owns no filter semantics.
 */

import { X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface ActiveFilterChip {
  /** Stable identity for React keys, e.g. "status:passed". */
  key: string;
  /** What the chip says; the remove button's aria-label reads "Remove {label} filter". */
  label: string;
  /** Status-dot class for outcome chips. */
  dot?: string;
  /** Render the label in mono (models and serving hosts are IDs). */
  mono?: boolean;
  onRemove: () => void;
}

export function ActiveFiltersRow({
  chips,
  onClearAll,
}: {
  chips: ActiveFilterChip[];
  onClearAll: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-6 py-2">
      <span className="text-[11px] uppercase tracking-wide text-foreground/50">Filters</span>
      {chips.map((chip) => (
        <Badge key={chip.key} variant="secondary" className="gap-1 pr-1 font-normal">
          {chip.dot && (
            <span className={cn("h-2 w-2 rounded-full", chip.dot)} aria-hidden />
          )}
          <span className={cn("max-w-[220px] truncate", chip.mono && "font-mono")}>
            {chip.label}
          </span>
          <button
            type="button"
            aria-label={`Remove ${chip.label} filter`}
            onClick={chip.onRemove}
            className="grid h-4 w-4 place-items-center text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-destructive"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="ml-1 text-[12px] text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        Clear all
      </button>
    </div>
  );
}
