"use client";

/**
 * The shared filter bar for the list pages (Tasks, a task's run history,
 * Runs).
 *
 * One row — search, Status, Model, Effort, Date — with the same controls and
 * the same density everywhere. The bar is fully controlled: each page keeps
 * owning its state (URL params or lifted state) and supplies its own status
 * vocabulary from `lib/filter-status`. The bar never fetches and never
 * mutates.
 *
 * Layout is stable by construction: the status trigger has a fixed width and
 * the model trigger a capped one, so changing a selection changes labels, not
 * positions.
 */

import { type ComponentPropsWithoutRef, type ReactNode, type Ref } from "react";
import { ChevronDown, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ModelFilterMenu } from "@/components/model-filter-menu";
import type { ModelPickerOption } from "@/lib/model-filter-options";
import { FilterPicker } from "@/components/filter-picker";
import { shortModel } from "@/lib/run-configuration";
import { ALL_SINCE_VALUE, sinceOptionsFor } from "@/lib/since-window";
import type { StatusFilterOption } from "@/lib/filter-status";
import { cn } from "@/lib/utils";

const ANY_EFFORT_VALUE = "__any__";

export interface FilterBarProps {
  statusOptions: StatusFilterOption[];
  status: Set<string>;
  onStatusChange: (next: Set<string>) => void;
  modelOptions: ModelPickerOption[];
  /** Empty = all models. May hold more than one when a page allows multi. */
  selectedModels: Set<string>;
  onSelectModel: (model: string | null) => void;
  /**
   * Render the model control even while its options are empty (e.g. facets
   * still loading). Defaults to hiding until there is something to show.
   */
  showModel?: boolean;
  /** Retire a model from the palette, or bring it back. */
  onSetArchived?: (model: string, archived: boolean) => void;
  /** Empty hides the effort control; gating on the selected model stays in the page. */
  effortOptions: { value: string; label: string }[];
  effort: string | null;
  onEffortChange: (effort: string | null) => void;
  /** Omit to hide the date control (e.g. demo projects have no cohort scoping). */
  since?: string | null;
  onSinceChange?: (since: string | null) => void;
  query?: string;
  onQueryChange?: (value: string) => void;
  searchPlaceholder?: string;
  searchTestId?: string;
  /** Shown when any dimension is in play; the bar computes "active" itself. */
  onClearAll?: () => void;
  /** Page-specific right side (result count, expand-all, reset link…). */
  trailing?: ReactNode;
}

export function FilterBar(props: FilterBarProps) {
  const showModelControl =
    props.showModel ?? (props.modelOptions.length > 0 || props.selectedModels.size > 0);
  const activeCount = countActive(props);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {props.onQueryChange && (
        <div className="relative min-w-[200px] flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            value={props.query ?? ""}
            onChange={(e) => props.onQueryChange?.(e.target.value)}
            placeholder={props.searchPlaceholder ?? "Filter…"}
            aria-label="Search"
            data-testid={props.searchTestId}
            className="h-8 border-border bg-card pl-8 text-[13px] placeholder:text-muted-foreground/50 focus-visible:border-border"
          />
        </div>
      )}

      <StatusFilterMenu
        options={props.statusOptions}
        status={props.status}
        onChange={props.onStatusChange}
      />

      {showModelControl && (
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-foreground/50">Model</span>
          <ModelFilterMenu
            options={props.modelOptions}
            selected={props.selectedModels}
            onSelect={props.onSelectModel}
            onClear={() => props.onSelectModel(null)}
            onSetArchived={props.onSetArchived}
            trigger={<ModelFilterTrigger selected={props.selectedModels} />}
          />
        </div>
      )}

      {props.effortOptions.length > 0 && (
        <FilterPicker
          label="Effort"
          value={props.effort ?? ANY_EFFORT_VALUE}
          options={[{ value: ANY_EFFORT_VALUE, label: "Any effort" }, ...props.effortOptions]}
          onChange={(v) => props.onEffortChange(v === ANY_EFFORT_VALUE ? null : v)}
        />
      )}

      {props.since !== undefined && props.onSinceChange && (
        <FilterPicker
          label="Date"
          value={props.since ?? ALL_SINCE_VALUE}
          options={sinceOptionsFor(props.since)}
          onChange={(v) => props.onSinceChange?.(v === ALL_SINCE_VALUE ? null : v)}
        />
      )}

      {props.onClearAll && activeCount > 0 && (
        <button
          type="button"
          onClick={props.onClearAll}
          className="text-[12px] text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Clear
        </button>
      )}

      {props.trailing && (
        <div className="ml-auto flex items-center gap-3 text-[12px] text-muted-foreground">
          {props.trailing}
        </div>
      )}
    </div>
  );
}

/** What the closed status trigger says: "All", ≤2 labels, or "n selected". */
function statusSummary(options: StatusFilterOption[], status: Set<string>): string {
  const selected = options.filter((o) => status.has(o.value));
  if (selected.length === 0 || selected.length === options.length) return "All";
  if (selected.length <= 2) return selected.map((o) => o.label).join(", ");
  return `${selected.length} selected`;
}

function countActive(p: FilterBarProps): number {
  const filtered =
    p.status.size > 0 && p.status.size < p.statusOptions.length ? 1 : 0;
  return (
    filtered + (p.selectedModels.size > 0 ? 1 : 0) + (p.effort ? 1 : 0) + (p.since ? 1 : 0)
  );
}

function StatusFilterMenu({
  options,
  status,
  onChange,
}: {
  options: StatusFilterOption[];
  status: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const summary = statusSummary(options, status);
  const filtered = summary !== "All";

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-foreground/50">Status</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Status filter"
            className={cn(
              // Fixed width so picking statuses never reshuffles the row —
              // the summary changes, the layout doesn't.
              "flex h-7 w-[168px] items-center gap-1.5 border px-2 text-[12px] transition-colors",
              filtered
                ? "border-foreground/30 bg-muted/60 text-foreground"
                : "border-input bg-muted/40 text-foreground hover:bg-muted/60",
            )}
          >
            {filtered && (
              <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
                {options
                  .filter((o) => status.has(o.value))
                  .slice(0, 3)
                  .map((o) => (
                    <span key={o.value} className={cn("h-2 w-2 rounded-full", o.dot)} />
                  ))}
              </span>
            )}
            <span className="truncate">{summary}</span>
            <ChevronDown className="ml-auto h-3 w-3 shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[14rem]">
          <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {filtered ? "Status — filtered" : "Status"}
          </DropdownMenuLabel>
          {options.map((opt) => (
            <DropdownMenuCheckboxItem
              key={opt.value}
              checked={status.has(opt.value)}
              onCheckedChange={() => {
                const next = new Set(status);
                if (next.has(opt.value)) next.delete(opt.value);
                else next.add(opt.value);
                onChange(next);
              }}
              // Stay open across picks: status is a multi-select, and closing
              // per pick makes building a selection needless clicky.
              onSelect={(e) => e.preventDefault()}
              className="text-[12px]"
            >
              <span className={cn("mr-1.5 inline-block h-2 w-2 rounded-full", opt.dot)} aria-hidden />
              {opt.label}
              {opt.count !== undefined && (
                <span className="ml-auto pl-3 font-mono text-[10px] tabular-nums text-muted-foreground/60">
                  {opt.count}
                </span>
              )}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * The compact h-7 model trigger shared by every filter bar call site (this
 * used to be copy-pasted per page, drifting as it went). Spreads the slot
 * props (ref + Radix trigger handlers) onto the button — without the spread,
 * `DropdownMenuTrigger asChild` renders a button that can never open.
 */
function ModelFilterTrigger({
  selected,
  ref,
  ...slotProps
}: {
  selected: Set<string>;
  ref?: Ref<HTMLButtonElement>;
} & ComponentPropsWithoutRef<"button">) {
  const only = selected.size === 1 ? Array.from(selected)[0] ?? null : null;
  return (
    <button
      {...slotProps}
      ref={ref}
      type="button"
      aria-label="Model filter"
      className="flex h-7 min-w-[140px] max-w-[200px] items-center justify-between gap-1 border border-input bg-muted/40 px-2 text-[12px] text-foreground hover:bg-muted/60"
    >
      <span className="truncate font-mono">
        {only
          ? shortModel(only)
          : selected.size > 1
            ? `${selected.size} models`
            : "All models"}
      </span>
      <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
    </button>
  );
}
