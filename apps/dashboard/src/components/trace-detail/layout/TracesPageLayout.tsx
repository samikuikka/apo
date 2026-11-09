"use client";

import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { TraceFilterControls, type TraceFilterOptions } from "@/components/trace-filter-controls";
import { fetchRunLabelFacets, type RunLabelFacets } from "@/lib/agent-task-api";
import { useProjectId } from "@/lib/project-router";
import { TraceActiveFilters } from "@/components/trace-active-filters";
import { useFilters } from "@/hooks/use-filters";
import { useIsMobile } from "@/hooks/use-mobile";
import { useRouter } from "next/navigation";
import { ListFilter, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Suspense, useEffect, useState, type ReactNode, useCallback, useSyncExternalStore } from "react";

export interface TracesPageLayoutProps {
  children: ReactNode;
  filterOptions?: TraceFilterOptions;
  spanFieldOptions?: { services?: string[]; operations?: string[] };
}

const CSV_REMOVE_KEYS = ["environment", "status", "user_id", "session_id"];

const FILTERS_VISIBLE_STORAGE_KEY = "traces-filters-visible";
const filtersVisibleListeners = new Set<() => void>();

function readStoredFiltersVisible(): string | null {
  try {
    return window.localStorage.getItem(FILTERS_VISIBLE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function subscribeToStoredFiltersVisible(onChange: () => void) {
  filtersVisibleListeners.add(onChange);
  // storage covers other tabs; same-tab toggles notify listeners directly.
  window.addEventListener("storage", onChange);
  return () => {
    filtersVisibleListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function writeStoredFiltersVisible(next: boolean) {
  try {
    window.localStorage.setItem(FILTERS_VISIBLE_STORAGE_KEY, String(next));
  } catch {
    // localStorage unavailable — the notification below still lets the
    // in-flight readers re-evaluate.
  }
  filtersVisibleListeners.forEach((notify) => notify());
}

/**
 * Filters-panel visibility, backed by localStorage as an external store.
 * useSyncExternalStore keeps the server/hydration snapshot neutral (null →
 * visible, the pre-persist default) and re-renders when the value changes —
 * no mount effect initializing state from a browser global. Same pattern as
 * hooks/use-mobile.tsx.
 */
function useFiltersVisible(): boolean {
  const stored = useSyncExternalStore(
    subscribeToStoredFiltersVisible,
    readStoredFiltersVisible,
    () => null,
  );
  return stored !== "false";
}

function getBasePath(pathname: string | null, fallback: string): string {
  if (!pathname?.startsWith("/project/")) return fallback;
  return pathname.replace(/\/traces.*$/, "/traces") || fallback;
}

function TracesPageLayoutInner({ children, filterOptions, spanFieldOptions }: TracesPageLayoutProps) {
  const [filters, actions] = useFilters();
  // Run-label options for the Labels section: the same facet summary the
  // Runs rail reads. Unavailable -> section hidden, filtering unaffected.
  const [labelFacets, setLabelFacets] = useState<RunLabelFacets | null>(null);
  // The project comes from the route (/project/<id>/traces), not from a
  // ?project= query param; reading filters.project here left the facets
  // unfetched and the Labels section hidden on the real page.
  const routeProjectId = useProjectId();
  useEffect(() => {
    if (!routeProjectId) {
      setLabelFacets(null);
      return;
    }
    let cancelled = false;
    fetchRunLabelFacets(routeProjectId)
      .then((facets) => {
        if (!cancelled) setLabelFacets(facets);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [routeProjectId]);
  const router = useRouter();
  const filtersVisible = useFiltersVisible();
  const isMobile = useIsMobile();
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const toggleFilters = useCallback(() => {
    writeStoredFiltersVisible(!filtersVisible);
  }, [filtersVisible]);

  const handleRemoveFilter = (key: keyof typeof filters, value?: any) => {
    const basePath = getBasePath(window.location.pathname, "/traces");
    if (key === "tags" && Array.isArray(value)) {
      actions.setTags(value);
    } else if (key === "models" && Array.isArray(value)) {
      actions.setModels(value);
    } else if (key === "span_predicates" && Array.isArray(value)) {
      actions.setSpanPredicates(value);
    } else if (CSV_REMOVE_KEYS.includes(key as string) && typeof value === "string") {
      const params = new URLSearchParams(window.location.search);
      const paramKey = key;
      const current = params.get(paramKey)?.split(",").filter(Boolean) ?? [];
      const next = current.filter((v) => v !== value);
      if (next.length > 0) {
        params.set(paramKey, next.join(","));
      } else {
        params.delete(paramKey);
      }
      router.push(`${basePath}?${params.toString()}`);
    } else {
      actions.removeFilter(key);
    }
  };

  // Mobile: the resizable filter rail is unusable below ~768px — filters
  // live in a bottom-corner-triggered sheet instead, table gets full width.
  if (isMobile) {
    return (
      <div className="relative h-full w-full overflow-auto">
        <Sheet open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
          <button
            type="button"
            onClick={() => setMobileFiltersOpen(true)}
            className="absolute bottom-4 right-4 z-10 flex h-8 items-center gap-1.5 border border-border bg-card px-3 text-xs font-medium text-foreground shadow-lg transition-colors hover:bg-accent"
            aria-label="Show filters"
            title="Show filters"
          >
            <ListFilter className="h-3.5 w-3.5" />
            Filters
          </button>
          <SheetContent side="left" className="w-4/5 max-w-xs overflow-y-auto p-0 sm:max-w-xs">
            <SheetHeader className="border-b border-border">
              <SheetTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Filters
              </SheetTitle>
            </SheetHeader>
            <div className="space-y-4 p-4">
              <TraceFilterControls
                labelFacets={labelFacets}
                filters={filters}
                actions={actions}
                availableEnvironments={["default", "dev", "staging", "production"]}
                filterOptions={filterOptions}
                spanFieldOptions={spanFieldOptions}
              />
              <TraceActiveFilters
                filters={filters}
                onRemoveFilter={handleRemoveFilter}
                onClearAll={actions.clearAllFilters}
              />
            </div>
          </SheetContent>
        </Sheet>
        {children}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      {filtersVisible && (
        <ResizablePanelGroup direction="horizontal" className="h-full w-full">
          <ResizablePanel defaultSize="25%" minSize="20%" className="overflow-auto">
            <div className="h-full w-full border-r p-4 overflow-y-auto">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Filters
                </span>
                <button
                  type="button"
                  onClick={toggleFilters}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-label="Hide filters"
                  title="Hide filters"
                >
                  <PanelLeftClose className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-4">
                <TraceFilterControls
                labelFacets={labelFacets}
                  filters={filters}
                  actions={actions}
                  availableEnvironments={["default", "dev", "staging", "production"]}
                  filterOptions={filterOptions}
                  spanFieldOptions={spanFieldOptions}
                />

                <TraceActiveFilters
                  filters={filters}
                  onRemoveFilter={handleRemoveFilter}
                  onClearAll={actions.clearAllFilters}
                />
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel defaultSize="75%" minSize="60%" className="overflow-auto">
            {children}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

      {!filtersVisible && (
        <div className="relative h-full w-full overflow-auto">
          <button
            type="button"
            onClick={toggleFilters}
            className="absolute left-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Show filters"
            title="Show filters"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
          {children}
        </div>
      )}
    </div>
  );
}

export function TracesPageLayout({ children, filterOptions }: TracesPageLayoutProps) {
  return (
    <Suspense>
      <TracesPageLayoutInner filterOptions={filterOptions}>{children}</TracesPageLayoutInner>
    </Suspense>
  );
}
