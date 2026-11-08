"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
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
}

export function ScopeRail({ facets, scope, onScopeChange, onClose }: ScopeRailProps & { onClose: () => void }) {
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
      <ScopeRailBody facets={facets} scope={scope} onScopeChange={onScopeChange} />
    </aside>
  );
}

export function ScopeRailSheet({
  facets,
  scope,
  onScopeChange,
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
        <ScopeRailBody facets={facets} scope={scope} onScopeChange={onScopeChange} />
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
  open,
  onToggle,
}: ScopeRailProps & { open: boolean; onToggle: () => void }) {
  const dims = useMemo(() => runScopeDimensions(facets, scope), [facets, scope]);
  const chips = runScopeChips(scope, dims);
  const Icon = open ? PanelLeftClose : PanelLeftOpen;

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
          open || chips.length > 0
            ? "border-foreground/30 bg-muted/60 text-foreground"
            : "border-input bg-muted/40 text-foreground hover:bg-muted/60",
        )}
      >
        <Icon className="h-3.5 w-3.5 opacity-70" />
        <span>{chips.length > 0 ? `${chips.length} active` : `${dims.length} dimensions`}</span>
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
      {!open && chips.length > 0 && (
        <button
          type="button"
          onClick={() => onScopeChange({ environments: [], labels: {} })}
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

function ScopeRailBody({ facets, scope, onScopeChange }: ScopeRailProps) {
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
        {chips.length > 0 && (
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
            <button
              type="button"
              onClick={() => onScopeChange({ environments: [], labels: {} })}
              className="text-[12px] text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Clear All
            </button>
          </div>
        )}
      </div>
    </>
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
