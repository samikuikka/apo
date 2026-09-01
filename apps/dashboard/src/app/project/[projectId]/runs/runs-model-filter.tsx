"use client";

import { ListFilter } from "lucide-react";
import { ModelFilterMenu } from "@/components/model-filter-menu";
import type { ModelPickerOption } from "@/lib/model-filter-options";
import { cn } from "@/lib/utils";

export type ModelOption = ModelPickerOption;

/**
 * a URL-backed multi-select facet for filtering runs by model.
 *
 * Lives on the Execution column header — the model is that column's data, so
 * the filter is discoverable in context. Options are derived from all loaded
 * batch summaries (selecting one value never removes the others from the
 * list). Selection is encoded as a comma-separated `?model=a,b` so a filtered
 * view is shareable. The filter itself (a batch matches when any of its
 * configurations uses a selected model) lives in the parent; this component
 * owns only the trigger — the menu body is shared with the Runs toolbar and
 * the Tasks page (see {@link ModelFilterMenu}).
 */
export function RunsModelFilter({
  options,
  selected,
  onToggle,
  onClear,
  onSetArchived,
}: {
  options: ModelOption[];
  selected: Set<string>;
  onToggle: (model: string) => void;
  onClear: () => void;
  onSetArchived: (model: string, archived: boolean) => void;
}) {
  const selectedCount = selected.size;
  const disabled = options.length === 0;

  return (
    <ModelFilterMenu
      options={options}
      selected={selected}
      multiple
      onToggle={onToggle}
      onClear={onClear}
      onSetArchived={onSetArchived}
      trigger={
        <button
          type="button"
          disabled={disabled}
          aria-label="Filter by model"
          className={cn(
            "inline-grid h-5 w-5 place-items-center rounded-sm align-middle transition-colors",
            disabled
              ? "cursor-not-allowed text-muted-foreground/30"
              : selectedCount > 0
                ? "bg-foreground text-background"
                : "text-muted-foreground/60 hover:bg-muted hover:text-foreground",
          )}
        >
          <ListFilter className="h-3 w-3" />
        </button>
      }
    />
  );
}
