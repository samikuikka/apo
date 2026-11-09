"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  X,
} from "lucide-react";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  ENVIRONMENT_DIMENSION,
  filterRunScopeDimensions,
  runScopeChips,
  runScopeDimensions,
  toggleRunScopeValue,
  type RunScope,
} from "@/lib/run-scope";
import {
  clearMetricRange,
  EMPTY_METRIC_FILTERS,
  medianLabel,
  metricChips,
  loadSavedScopes,
  metricPresets,
  railOwnedParams,
  saveSavedScopes,
  type SavedRunScope,
  type MetricPreset,
  type MetricQuantiles,
  type MetricRange,
  type RunMetricFilters,
} from "@/lib/run-metric-filters";
import type { RunLabelFacets } from "@/lib/agent-task-api";
import { cn } from "@/lib/utils";

/**
 * The Runs page environment and label filters as a left rail: every dimension
 * the project's runs carry, one collapsible section per dimension, one
 * checkbox per value with its run count. Every click applies immediately and
 * rewrites the URL scope (`?environment=&label=key:id`), the same params the
 * list endpoints filter by, so a filtered view is always a shareable link.
 *
 * The rail closes from its header and reopens from {@link RailToggle} in the
 * filter row; while closed, RailToggle shows the active filters as chips so a
 * hidden rail never hides the fact that the list is filtered. Visibility is
 * remembered per browser (localStorage), like the Traces rail. Below md the
 * same sections live in a sheet ({@link ScopeRailSheet}) because a fixed-width
 * rail starves the table.
 */
export interface ScopeRailProps {
  facets: RunLabelFacets | null;
  scope: RunScope;
  onScopeChange: (next: RunScope) => void;
  /** Stored-metric ranges (cost, duration); omitted hides those sections. */
  metrics?: RunMetricFilters;
  onMetricsChange?: (next: RunMetricFilters) => void;
  /** Applies a saved scope's raw rail params (the page supplies the URL
   * writer); omitted hides the saved-scopes block. */
  onApplyParams?: (params: string) => void;
  /** The URL's current rail-owned params, for saving the active filters. */
  currentParams?: string;
}

export function ScopeRail({
  facets,
  scope,
  onScopeChange,
  metrics,
  onMetricsChange,
  onApplyParams,
  currentParams,
  onClose,
}: ScopeRailProps & { onClose: () => void }) {
  return (
    <aside aria-label="Filters" className="flex w-[264px] shrink-0 flex-col border-r border-border">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Filters
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Hide filters"
          title="Hide filters"
          className="flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>
      <ScopeRailBody
        facets={facets}
        scope={scope}
        onScopeChange={onScopeChange}
        metrics={metrics}
        onMetricsChange={onMetricsChange}
        onApplyParams={onApplyParams}
        currentParams={currentParams}
      />
    </aside>
  );
}

export function ScopeRailSheet({
  facets,
  scope,
  onScopeChange,
  metrics,
  onMetricsChange,
  onApplyParams,
  currentParams,
  open,
  onOpenChange,
}: ScopeRailProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-4/5 max-w-xs overflow-y-auto p-0 sm:max-w-xs">
        <SheetHeader className="border-b border-border">
          <SheetTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Filters
          </SheetTitle>
        </SheetHeader>
        <ScopeRailBody
          facets={facets}
          scope={scope}
          onScopeChange={onScopeChange}
          metrics={metrics}
          onMetricsChange={onMetricsChange}
          onApplyParams={onApplyParams}
          currentParams={currentParams}
        />
      </SheetContent>
    </Sheet>
  );
}

/**
 * The rail's control in the filter row. Opens and closes the rail; while the
 * rail is closed it also shows the active filters as chips, so a hidden rail
 * never hides the fact that the list is filtered.
 */
export function RailToggle({
  facets,
  scope,
  onScopeChange,
  metrics,
  onMetricsChange,
  open,
  onToggle,
}: ScopeRailProps & { open: boolean; onToggle: () => void }) {
  const dims = useMemo(() => runScopeDimensions(facets, scope), [facets, scope]);
  const chips = runScopeChips(scope, dims);
  const ranges = metrics !== undefined ? metricChips(metrics) : [];
  const activeCount = chips.length + ranges.length;
  const Icon = open ? PanelLeftClose : PanelLeftOpen;
  const clearAll = () => {
    onScopeChange({ environments: [], labels: {} });
    onMetricsChange?.(EMPTY_METRIC_FILTERS);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-foreground/50">Filters</span>
      <button
        type="button"
        aria-pressed={open}
        aria-label={open ? "Hide filters" : "Show filters"}
        onClick={onToggle}
        className={cn(
          "flex h-7 items-center gap-1.5 border px-2 text-[12px] transition-colors",
          open || activeCount > 0
            ? "border-foreground/30 bg-muted/60 text-foreground"
            : "border-input bg-muted/40 text-foreground hover:bg-muted/60",
        )}
      >
        <Icon className="h-3.5 w-3.5 opacity-70" />
        <span>{activeCount > 0 ? `${activeCount} active` : `${dims.length} dimensions`}</span>
      </button>
      {!open &&
        chips.map((chip) => (
          <FilterChip
            key={`${chip.key}:${chip.id}`}
            dimension={chip.label}
            value={chip.name}
            onRemove={() => onScopeChange(toggleRunScopeValue(scope, chip.key, chip.id))}
          />
        ))}
      {!open &&
        ranges.map((range) => (
          <FilterChip
            key={`${range.metric}:${range.text}`}
            dimension={range.metric}
            value={range.text}
            onRemove={() =>
              onMetricsChange?.(clearMetricRange(metrics ?? EMPTY_METRIC_FILTERS, range.kind))
            }
          />
        ))}
      {!open && activeCount > 0 && (
        <button
          type="button"
          onClick={clearAll}
          className="text-[12px] text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Clear
        </button>
      )}
    </div>
  );
}

const RAIL_VISIBLE_KEY = "runs-filters-visible";
const railListeners = new Set<() => void>();

function subscribeRail(onChange: () => void) {
  railListeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    railListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readRail(): string | null {
  try {
    return window.localStorage.getItem(RAIL_VISIBLE_KEY);
  } catch {
    return null;
  }
}

/**
 * The sheet (mobile rail) open flag, shared in memory: the toggle and the
 * rail can live in different components on the task-history page, and both
 * must flip the same sheet.
 */
const sheetListeners = new Set<() => void>();
let sheetOpenMemory = false;

function subscribeSheet(onChange: () => void) {
  sheetListeners.add(onChange);
  return () => {
    sheetListeners.delete(onChange);
  };
}

export function useRailSheetOpen(): [boolean, (next: boolean) => void] {
  const open = useSyncExternalStore(
    subscribeSheet,
    () => sheetOpenMemory,
    () => false,
  );
  const setOpen = useCallback((next: boolean) => {
    sheetOpenMemory = next;
    sheetListeners.forEach((notify) => notify());
  }, []);
  return [open, setOpen];
}

/**
 * Rail visibility, remembered per browser. The external-store pattern keeps
 * the server snapshot neutral (null means visible) so hydration never
 * mismatches; storage events keep other tabs in sync.
 */
export function useRailVisible(): [boolean, (next: boolean) => void] {
  const stored = useSyncExternalStore(subscribeRail, readRail, () => null);
  const setVisible = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(RAIL_VISIBLE_KEY, String(next));
    } catch {
      // Storage unavailable: the in-memory notification below still applies.
    }
    railListeners.forEach((notify) => notify());
  }, []);
  return [stored !== "false", setVisible];
}

function ScopeRailBody({
  facets,
  scope,
  onScopeChange,
  metrics,
  onMetricsChange,
  onApplyParams,
  currentParams,
}: ScopeRailProps) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const dims = useMemo(() => runScopeDimensions(facets, scope), [facets, scope]);
  const visible = useMemo(() => filterRunScopeDimensions(dims, query), [dims, query]);
  const chips = runScopeChips(scope, dims);

  const toggleSection = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <>
      <div className="px-4 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search dimensions and values…"
            aria-label="Search dimensions and values"
            className="h-8 w-full border border-border bg-card pl-8 text-[12px] outline-none placeholder:text-muted-foreground/50"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {metrics !== undefined && onMetricsChange !== undefined && (
          <MetricSections
            metrics={metrics}
            onMetricsChange={onMetricsChange}
            costQuantiles={facets?.metrics?.cost}
            durationQuantiles={facets?.metrics?.duration_seconds}
          />
        )}
        {visible.length === 0 && (
          <div className="py-2 text-[12px] text-muted-foreground">
            No dimension or value matches.
          </div>
        )}
        {visible.map((dim) => {
          const isOpen = query !== "" || !collapsed.has(dim.key);
          const picked =
            dim.key === ENVIRONMENT_DIMENSION ? scope.environments : (scope.labels[dim.key] ?? []);
          return (
            <div key={dim.key} className="border-b border-border">
              <button
                type="button"
                onClick={() => toggleSection(dim.key)}
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between py-2 text-xs font-medium hover:underline"
              >
                <span className={dim.key === ENVIRONMENT_DIMENSION ? "" : "font-mono"}>
                  {dim.label}
                </span>
                <span className="flex items-center gap-1.5">
                  {picked.length > 0 && (
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                      {picked.length}
                    </span>
                  )}
                  {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </span>
              </button>
              {isOpen && (
                <div className="pb-2">
                  {dim.values.map((value) => {
                    const checked = picked.includes(value.id);
                    return (
                      <button
                        key={value.id}
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        aria-label={`${dim.label} ${value.name}`}
                        onClick={() => onScopeChange(toggleRunScopeValue(scope, dim.key, value.id))}
                        className="flex w-full cursor-pointer items-center gap-2 py-1 text-left text-[12px] hover:bg-muted/60"
                      >
                        <span
                          className={cn(
                            "flex h-3.5 w-3.5 shrink-0 items-center justify-center border",
                            checked ? "border-foreground bg-foreground" : "border-border",
                          )}
                        >
                          {checked && <Check className="h-3 w-3 text-background" />}
                        </span>
                        <span className="truncate">{value.name}</span>
                        <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground/60">
                          {value.count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {(chips.length > 0 || (metrics !== undefined && metricChips(metrics).length > 0)) && (
          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            <span className="w-full text-[11px] uppercase tracking-wide text-foreground/50">
              Active
            </span>
            {chips.map((chip) => (
              <FilterChip
                key={`${chip.key}:${chip.id}`}
                dimension={chip.label}
                value={chip.name}
                onRemove={() => onScopeChange(toggleRunScopeValue(scope, chip.key, chip.id))}
              />
            ))}
            {metrics !== undefined &&
              metricChips(metrics).map((range) => (
                <FilterChip
                  key={`${range.metric}:${range.text}`}
                  dimension={range.metric}
                  value={range.text}
                  onRemove={() =>
                    onMetricsChange?.(clearMetricRange(metrics, range.kind))
                  }
                />
              ))}
            <button
              type="button"
              onClick={() => {
                onScopeChange({ environments: [], labels: {} });
                onMetricsChange?.(EMPTY_METRIC_FILTERS);
              }}
              className="text-[12px] text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Clear All
            </button>
          </div>
        )}
        <SavedScopes onApplyParams={onApplyParams} currentParams={currentParams} />
      </div>
    </>
  );
}

/**
 * Named filter sets, saved per browser. A saved scope stores exactly the
 * rail-owned params (scope + metric ranges), so applying it never touches
 * page numbers or anyone else's filters.
 */
function SavedScopes({
  onApplyParams,
  currentParams,
}: {
  onApplyParams?: (params: string) => void;
  currentParams?: string;
}) {
  const [entries, setEntries] = useState<SavedRunScope[]>([]);
  const [name, setName] = useState("");
  // localStorage is browser-only; load after mount so SSR renders nothing.
  useEffect(() => {
    setEntries(loadSavedScopes());
  }, []);

  if (onApplyParams === undefined || currentParams === undefined) return null;

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const entry: SavedRunScope = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmed,
      params: currentParams,
    };
    const next = [...entries, entry];
    setEntries(next);
    saveSavedScopes(next);
    setName("");
  };

  const remove = (id: string) => {
    const next = entries.filter((entry) => entry.id !== id);
    setEntries(next);
    saveSavedScopes(next);
  };

  return (
    <div className="mt-4 border-t border-border pt-3">
      <span className="mb-1.5 block text-[11px] uppercase tracking-wide text-foreground/50">
        Saved Views
      </span>
      <div className="flex flex-col gap-1">
        {entries.map((entry) => (
          <div key={entry.id} className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onApplyParams(entry.params)}
              className="flex-1 truncate border border-border px-2 py-1 text-left text-[12px] hover:bg-muted/60"
            >
              {entry.name}
            </button>
            <button
              type="button"
              aria-label={`Delete ${entry.name}`}
              onClick={() => remove(entry.id)}
              className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
          }}
          placeholder="name this view"
          aria-label="Saved view name"
          className="h-7 w-full border border-border bg-card px-2 text-[12px] outline-none placeholder:text-muted-foreground/50"
        />
        <button
          type="button"
          onClick={save}
          disabled={!name.trim()}
          className="h-7 border border-border px-2 text-[12px] text-muted-foreground hover:bg-muted/60 disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}

/**
 * The two stored-metric range sections: Cost (dollars) and Duration
 * (presets in minutes, custom bounds typed in minutes and carried as
 * seconds). Presets apply on click; the inputs commit on blur or Enter so a
 * half-typed number never touches the URL.
 */
function MetricSections({
  metrics,
  onMetricsChange,
  costQuantiles,
  durationQuantiles,
}: {
  metrics: RunMetricFilters;
  onMetricsChange: (next: RunMetricFilters) => void;
  costQuantiles: MetricQuantiles | null | undefined;
  durationQuantiles: MetricQuantiles | null | undefined;
}) {
  const setCost = (cost: MetricRange) => onMetricsChange({ ...metrics, cost });
  const setDuration = (durationSeconds: MetricRange) =>
    onMetricsChange({ ...metrics, durationSeconds });
  return (
    <>
      <MetricSection title="Cost" median={medianLabel(costQuantiles, "cost")}>
        <RangeInputs
          ariaPrefix="Cost"
          bounds={metrics.cost}
          format={(value) => String(value)}
          parse={(text) => Number(text)}
          onChange={setCost}
        />
        <Presets
          presets={metricPresets(costQuantiles, "cost")}
          bounds={metrics.cost}
          onSelect={setCost}
        />
      </MetricSection>
      <MetricSection title="Duration" median={medianLabel(durationQuantiles, "duration")}>
        <RangeInputs
          ariaPrefix="Duration"
          bounds={metrics.durationSeconds}
          format={(seconds) => String(seconds / 60)}
          parse={(text) => Number(text) * 60}
          onChange={setDuration}
          suffix="min"
        />
        <Presets
          presets={metricPresets(durationQuantiles, "duration")}
          bounds={metrics.durationSeconds}
          onSelect={setDuration}
        />
      </MetricSection>
    </>
  );
}

function MetricSection({
  title,
  median,
  children,
}: {
  title: string;
  median: string | null;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-border pb-2">
      <span className="flex items-baseline justify-between py-2 text-xs font-medium">
        {title}
        {median && (
          <span className="font-mono text-[10px] font-normal text-muted-foreground">
            {median}
          </span>
        )}
      </span>
      {children}
    </div>
  );
}

function RangeInputs({
  ariaPrefix,
  bounds,
  format,
  parse,
  onChange,
  suffix,
}: {
  ariaPrefix: string;
  bounds: MetricRange;
  format: (value: number) => string;
  parse: (text: string) => number;
  onChange: (next: MetricRange) => void;
  suffix?: string;
}) {
  const [minText, setMinText] = useState(bounds.min === null ? "" : format(bounds.min));
  const [maxText, setMaxText] = useState(bounds.max === null ? "" : format(bounds.max));
  // External changes (a preset pick, Clear All, back/forward) re-sync the
  // inputs during render via a prev-value compare.
  const [prev, setPrev] = useState(bounds);
  if (prev !== bounds) {
    setPrev(bounds);
    setMinText(bounds.min === null ? "" : format(bounds.min));
    setMaxText(bounds.max === null ? "" : format(bounds.max));
  }
  const commit = (which: "min" | "max", text: string) => {
    const trimmed = text.trim();
    const value = trimmed === "" ? null : parse(trimmed);
    const next = value !== null && Number.isFinite(value) && value >= 0 ? value : null;
    const range = which === "min" ? { ...bounds, min: next } : { ...bounds, max: next };
    // An inverted pair (min above max) matches nothing; commit it in order
    // so the chip always names a real range instead of an empty list.
    if (range.min !== null && range.max !== null && range.min > range.max) {
      onChange({ min: range.max, max: range.min });
      return;
    }
    onChange(range);
  };
  return (
    <div className="flex items-center gap-1.5">
      <input
        value={minText}
        onChange={(event) => setMinText(event.target.value)}
        onBlur={() => commit("min", minText)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit("min", minText);
        }}
        aria-label={`${ariaPrefix} minimum`}
        placeholder="min"
        className="h-7 w-full border border-border bg-card px-2 font-mono text-[12px] outline-none placeholder:text-muted-foreground/50"
      />
      <span className="text-[11px] text-muted-foreground">to</span>
      <input
        value={maxText}
        onChange={(event) => setMaxText(event.target.value)}
        onBlur={() => commit("max", maxText)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit("max", maxText);
        }}
        aria-label={`${ariaPrefix} maximum`}
        placeholder={suffix ?? "max"}
        className="h-7 w-full border border-border bg-card px-2 font-mono text-[12px] outline-none placeholder:text-muted-foreground/50"
      />
    </div>
  );
}

function Presets({
  presets,
  bounds,
  onSelect,
}: {
  presets: MetricPreset[];
  bounds: MetricRange;
  onSelect: (next: MetricRange) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {presets.map((preset) => {
        const pressed = bounds.min === preset.min && bounds.max === preset.max;
        return (
          <button
            key={preset.label}
            type="button"
            aria-pressed={pressed}
            onClick={() => onSelect(pressed ? { min: null, max: null } : { min: preset.min, max: preset.max })}
            className={cn(
              "border px-1.5 py-0.5 text-[11px]",
              pressed
                ? "border-foreground/30 bg-muted text-foreground"
                : "border-border text-muted-foreground hover:bg-muted/60",
            )}
          >
            {preset.label}
            <span className="ml-1 text-muted-foreground/70">{preset.detail}</span>
          </button>
        );
      })}
    </div>
  );
}

function FilterChip({
  dimension,
  value,
  onRemove,
}: {
  dimension: string;
  value: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 border border-border bg-muted/40 pl-2 text-[11px]">
      <span className="text-muted-foreground">{dimension}</span>
      <span>{value}</span>
      <button
        type="button"
        aria-label={`Remove ${dimension} ${value}`}
        onClick={onRemove}
        className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
