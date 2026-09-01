"use client";

import { ReactNode, useMemo } from "react";
import { Archive, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { shortModel } from "@/lib/run-configuration";
import { type ModelPickerOption, visibleModels } from "@/lib/model-filter-options";

/**
 * The model filter menu shared by the Runs and Tasks pages.
 *
 * Options are derived from every run a project has recorded, so the list only
 * ever grows — a model that ran once stays in it forever. **Manage Models**
 * (the submenu) archives one out of the list, or brings it back; archiving is
 * project-wide and display-only, so an archived model's runs still exist,
 * still count, and are still reachable by `?model=`.
 *
 * Archiving lives in a submenu rather than on each row because filtering is the
 * common action and retiring a model is a once-a-month one. It also keeps the
 * rows free of nested interactive elements, which a menu item cannot carry
 * accessibly, and gives the cleanup a place to happen in bulk.
 *
 * A model the current filter selects is always listed even when archived —
 * otherwise the active filter would be invisible and unclearable.
 *
 * `trigger` is supplied by the caller: the three sites (Runs toolbar, the Runs
 * Execution column header, the Tasks filter row) each keep their own control
 * shape, and share only this menu body.
 */
export function ModelFilterMenu({
  trigger,
  options,
  selected,
  multiple = false,
  onToggle,
  onSelect,
  onClear,
  onSetArchived,
  align = "start",
}: {
  trigger: ReactNode;
  options: ModelPickerOption[];
  /** Empty = no model filter (all models). */
  selected: Set<string>;
  /** Multi-select (checkboxes, menu stays open) vs single-select. */
  multiple?: boolean;
  /** Multi-select: toggle one model. */
  onToggle?: (model: string) => void;
  /** Single-select: pick one model, or `null` for all. */
  onSelect?: (model: string | null) => void;
  onClear: () => void;
  onSetArchived?: (model: string, archived: boolean) => void;
  align?: "start" | "end";
}) {
  const visible = useMemo(
    () => visibleModels(options, selected),
    [options, selected],
  );
  const archivedCount = useMemo(
    () => options.filter((o) => o.archived).length,
    [options],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-[16rem]">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Filter by model
        </DropdownMenuLabel>
        <div className="max-h-72 overflow-auto">
          {!multiple && (
            <DropdownMenuCheckboxItem
              checked={selected.size === 0}
              onCheckedChange={() => onSelect?.(null)}
            >
              All models
            </DropdownMenuCheckboxItem>
          )}
          {visible.map(({ model, count, archived }) => (
            <DropdownMenuCheckboxItem
              key={model}
              checked={selected.has(model)}
              onCheckedChange={() =>
                multiple ? onToggle?.(model) : onSelect?.(model)
              }
              // Multi-select keeps the menu open so several can be picked in
              // one visit; single-select closes, as a picker should.
              onSelect={multiple ? (e) => e.preventDefault() : undefined}
            >
              <span className="font-mono">{shortModel(model)}</span>
              {archived && (
                <span className="pl-2 text-[10px] uppercase tracking-wide text-muted-foreground/60">
                  Archived
                </span>
              )}
              <span className="ml-auto pl-3 font-mono text-[10px] tabular-nums text-muted-foreground/60">
                {count}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
          {visible.length === 0 && (
            <div className="px-2 py-1.5 text-[12px] text-muted-foreground/60">
              {archivedCount > 0 ? "Every model is archived" : "No models yet"}
            </div>
          )}
        </div>

        {multiple && selected.size > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onClear} className="gap-1.5 text-muted-foreground">
              <X className="h-3 w-3" />
              Clear filter
            </DropdownMenuItem>
          </>
        )}

        {options.length > 0 && onSetArchived && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="gap-1.5 text-muted-foreground">
                <Archive className="h-3 w-3" />
                Manage Models
                {archivedCount > 0 && (
                  <span className="ml-auto pl-3 font-mono text-[10px] tabular-nums text-muted-foreground/60">
                    {archivedCount}
                  </span>
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[16rem]">
                <DropdownMenuLabel className="text-[11px] font-normal normal-case text-muted-foreground/70">
                  Archived models are hidden from the filter. Their runs are
                  kept.
                </DropdownMenuLabel>
                <div className="max-h-72 overflow-auto">
                  {options.map(({ model, count, archived }) => (
                    <DropdownMenuCheckboxItem
                      key={model}
                      checked={archived}
                      onCheckedChange={(next) => onSetArchived(model, next === true)}
                      onSelect={(e) => e.preventDefault()}
                      aria-label={`${archived ? "Restore" : "Archive"} ${model}`}
                    >
                      <span className="font-mono">{shortModel(model)}</span>
                      <span className="ml-auto pl-3 font-mono text-[10px] tabular-nums text-muted-foreground/60">
                        {count}
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </div>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

