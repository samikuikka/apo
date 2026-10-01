"use client";

import { Fragment, ReactNode, useMemo } from "react";
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
import {
  type ModelPickerOption,
  visibleModels,
  groupModelsByProvider,
} from "@/lib/model-filter-options";

/**
 * The model filter menu shared by the Runs and Tasks pages.
 *
 * Options are derived from every run a project has recorded, so the list only
 * ever grows — a model that ran once stays in it forever. Past a handful of
 * models the list sections by provider prefix (`groupModelsByProvider`); a
 * short list stays flat. **Manage Models** (the submenu) archives a model out
 * of the list, or brings it back; archiving is project-wide and display-only,
 * so an archived model's runs still exist, still count, and are still
 * reachable by `?model=`.
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
          <ModelOptionList
            options={visible}
            isChecked={(option) => selected.has(option.model)}
            onCheck={(model) => {
              if (multiple) onToggle?.(model);
              else onSelect?.(model);
            }}
            // Multi-select keeps the menu open so several can be picked in
            // one visit; single-select closes, as a picker should.
            closeOnSelect={!multiple}
          />
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
                  <ModelOptionList
                    options={options}
                    isChecked={(option) => option.archived}
                    onCheck={(model, next) => onSetArchived(model, next)}
                    closeOnSelect={false}
                    manageMode
                  />                </div>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The model rows, flat when the list is short and sectioned by provider when
 * it is long (`groupModelsByProvider` decides — same rule everywhere the list
 * appears). In a section the rows show the short name because the prefix is
 * the header right above them; `title` keeps the full id one hover away.
 */
function ModelOptionList({
  options,
  isChecked,
  onCheck,
  closeOnSelect,
  manageMode = false,
}: {
  options: ModelPickerOption[];
  isChecked: (option: ModelPickerOption) => boolean;
  /** `next` is the checkbox state the user just set. */
  onCheck: (model: string, next: boolean) => void;
  /** `false` keeps the menu open across picks (multi-select, manage mode). */
  closeOnSelect: boolean;
  /** Manage mode checks mean "archived", which flips the row's aria label. */
  manageMode?: boolean;
}) {
  const groups = useMemo(() => groupModelsByProvider(options), [options]);

  const renderRow = (option: ModelPickerOption) => (
    <DropdownMenuCheckboxItem
      key={option.model}
      checked={isChecked(option)}
      onCheckedChange={(next) => onCheck(option.model, next === true)}
      onSelect={closeOnSelect ? undefined : (e) => e.preventDefault()}
      title={option.model}
      aria-label={
        manageMode
          ? `${isChecked(option) ? "Restore" : "Archive"} ${option.model}`
          : option.model
      }
    >
      <span className="font-mono">{shortModel(option.model)}</span>
      {option.archived && !manageMode && (
        <span className="pl-2 text-[10px] uppercase tracking-wide text-muted-foreground/60">
          Archived
        </span>
      )}
      <span className="ml-auto pl-3 font-mono text-[10px] tabular-nums text-muted-foreground/60">
        {option.count}
      </span>
    </DropdownMenuCheckboxItem>
  );

  if (groups === null) return <>{options.map(renderRow)}</>;

  return (
    <>
      {groups.map((group) => (
        <Fragment key={group.provider}>
          <DropdownMenuLabel className="flex px-2 py-1 font-mono text-[10px] tracking-wide text-muted-foreground/70">
            {group.provider}
            <span className="ml-auto pl-3 tabular-nums">
              {group.totalRuns}
            </span>
          </DropdownMenuLabel>
          {group.models.map(renderRow)}
        </Fragment>
      ))}
    </>
  );
}

