"use client";

import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import {
} from "@/components/ui/sheet";
import { TraceFilterControls, type TraceFilterOptions } from "@/components/trace-filter-controls";
import { FilterRailFrame, FilterRailSheetFrame, useFilterRailSheetOpen, useFilterRailVisible } from "@/components/filter-rail-shell";
import { fetchRunLabelFacets, type RunLabelFacets } from "@/lib/agent-task-api";
import { useProjectId } from "@/lib/project-router";
import { TraceActiveFilters } from "@/components/trace-active-filters";
import { useFilters } from "@/hooks/use-filters";
import { useIsMobile } from "@/hooks/use-mobile";
import { useRouter } from "next/navigation";
import { ListFilter, PanelLeftOpen } from "lucide-react";
import { Suspense, useEffect, useState, type ReactNode, useCallback } from "react";

export interface TracesPageLayoutProps {
  children: ReactNode;
  filterOptions?: TraceFilterOptions;
  spanFieldOptions?: { services?: string[]; operations?: string[] };
}

const CSV_REMOVE_KEYS = ["environment", "status", "user_id", "session_id"];

const TRACES_RAIL_KEY = "traces-filters-visible";

function getBasePath(pathname: string | null, fallback: string): string {
  if (!pathname?.startsWith("/project/")) return fallback;
  return pathname.replace(/\/traces.*$/, "/traces") || fallback;
}

function TracesPageLayoutInner({ children, filterOptions, spanFieldOptions }: TracesPageLayoutProps) {
  const [filters, actions] = useFilters();
  // Run-label options for the Labels section: the same facet summary the
  // Runs rail reads. Unavailable -> section hidden, filtering unaffected.
  const [labelFacets, setLabelFacets] = useState<RunLabelFacets | null>(null);
  // Discovered environments replace the hardcoded list once facets load;
  // until then the fallback keeps the dropdown from flashing empty.
  const availableEnvironments =
    labelFacets && labelFacets.environments.length > 0
      ? labelFacets.environments.map((bucket) => bucket.value)
      : ["default", "dev", "staging", "production"];
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
  const [filtersVisible, setFiltersVisible] = useFilterRailVisible(TRACES_RAIL_KEY);
  const isMobile = useIsMobile();
  const [mobileFiltersOpen, setMobileFiltersOpen] = useFilterRailSheetOpen(TRACES_RAIL_KEY);

  const toggleFilters = useCallback(() => {
    setFiltersVisible(!filtersVisible);
  }, [filtersVisible, setFiltersVisible]);

  const handleRemoveFilter = (key: keyof typeof filters, value?: any) => {
    const basePath = getBasePath(window.location.pathname, "/traces");
    if (key === "tags" && Array.isArray(value)) {
      actions.setTags(value);
    } else if (key === "models" && Array.isArray(value)) {
      actions.setModels(value);
    } else if (key === "providers" && Array.isArray(value)) {
      actions.setProviders(value);
    } else if (key === "labels" && typeof value === "object" && value !== null) {
      actions.setLabels(value as Record<string, string[]>);
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
        <FilterRailSheetFrame open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
          <div className="space-y-4">
            <TraceFilterControls
              labelFacets={labelFacets}
              filters={filters}
              actions={actions}
              availableEnvironments={availableEnvironments}
              filterOptions={filterOptions}
              spanFieldOptions={spanFieldOptions}
            />
            <TraceActiveFilters
              filters={filters}
              onRemoveFilter={handleRemoveFilter}
              onClearAll={actions.clearAllFilters}
            />
          </div>
        </FilterRailSheetFrame>
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
        {children}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      {filtersVisible && (
        <ResizablePanelGroup direction="horizontal" className="h-full w-full">
          <ResizablePanel defaultSize="25%" minSize="20%" className="overflow-auto">
            <FilterRailFrame
              onClose={toggleFilters}
              className="h-full w-full border-r p-4"
            >
              <div className="space-y-4">
                <TraceFilterControls
                  labelFacets={labelFacets}
                  filters={filters}
                  actions={actions}
                  availableEnvironments={availableEnvironments}
                  filterOptions={filterOptions}
                  spanFieldOptions={spanFieldOptions}
                />
                <TraceActiveFilters
                  filters={filters}
                  onRemoveFilter={handleRemoveFilter}
                  onClearAll={actions.clearAllFilters}
                />
              </div>
            </FilterRailFrame>
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
