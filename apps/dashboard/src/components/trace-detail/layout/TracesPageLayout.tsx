"use client";

import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { TraceFilterControls, type TraceFilterOptions } from "@/components/trace-filter-controls";
import { TraceActiveFilters } from "@/components/trace-active-filters";
import { useFilters } from "@/hooks/use-filters";
import { useRouter } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Suspense, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

export interface TracesPageLayoutProps {
  children: ReactNode;
  filterOptions?: TraceFilterOptions;
}

const CSV_REMOVE_KEYS = ["environment", "status", "user_id", "session_id"];

function getBasePath(pathname: string | null, fallback: string): string {
  if (!pathname?.startsWith("/project/")) return fallback;
  return pathname.replace(/\/traces.*$/, "/traces") || fallback;
}

function TracesPageLayoutInner({ children, filterOptions }: TracesPageLayoutProps) {
  const [filters, actions] = useFilters();
  const router = useRouter();
  const [filtersVisible, setFiltersVisible] = useState(true);
  // Ref shadowing the state so toggleFilters can read the current value without
  // a stale closure (its useCallback has empty deps). Kept in sync on both the
  // hydration path and the toggle path.
  const filtersVisibleRef = useRef(true);

  useEffect(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem("traces-filters-visible") : null;
    if (stored !== null) {
      const next = stored === "true";
      filtersVisibleRef.current = next;
      setFiltersVisible(next);
    }
  }, []);

  const toggleFilters = useCallback(() => {
    // Side effect (localStorage write) lives in the event handler, NOT inside
    // the state updater — React may double-invoke functional updaters in
    // StrictMode/Concurrent, so the updater must stay pure.
    const next = !filtersVisibleRef.current;
    filtersVisibleRef.current = next;
    setFiltersVisible(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("traces-filters-visible", String(next));
    }
  }, []);

  const handleRemoveFilter = (key: keyof typeof filters, value?: any) => {
    const basePath = getBasePath(window.location.pathname, "/traces");
    if (key === "tags" && Array.isArray(value)) {
      actions.setTags(value);
    } else if (key === "models" && Array.isArray(value)) {
      actions.setModels(value);
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
                  filters={filters}
                  actions={actions}
                  availableEnvironments={["default", "dev", "staging", "production"]}
                  filterOptions={filterOptions}
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
