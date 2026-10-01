"use client";

import { Plus, X } from "lucide-react";

import type { RunConfigModelFacet } from "@/lib/agent-task-view-api";
import { cn } from "@/lib/utils";
import { FilterBar } from "@/components/filter-bar";
import { TASK_STATUS_FILTERS } from "@/lib/filter-status";

import { MAIN_VIEW_ID, type ViewTab } from "./task-list-shared";

const ALL_MODELS_VALUE = "__all__";

/** A short, human-readable config line for a tab chip (e.g. "Opus · high"). */
function viewConfigLabel(view: ViewTab): string {
  if (
    view.model === null &&
    view.effort === null &&
    view.since === null &&
    view.provider === null
  ) {
    return "everything";
  }
  const parts: string[] = [view.model ?? "all models"];
  if (view.effort) parts.push(view.effort);
  if (view.since) parts.push(view.since);
    if (view.provider) parts.push(view.provider);
  return parts.join(" · ");
}

export function EvidenceViewsBar({
  views,
  activeViewId,
  facets,
  hostFacets = [],
  loading,
  isDerived,
  viewsActive,
  addingTab,
  statusCounts,
  query,
  onQueryChange,
  selectedCount,
  onClearSelection,
  onToggleExpandAll,
  allExpanded,
  status,
  onStatusChange,
  onSelect,
  onChange,
  onSetArchived,
  onDuplicate,
  onClose,
}: {
  views: ViewTab[];
  activeViewId: string;
  facets: RunConfigModelFacet[];
  /** Serving-host palette for the Hosts view filter (issue #307). */
  hostFacets?: { label: string; count: number }[];
  loading: boolean;
  isDerived: boolean;
  viewsActive: boolean;
  addingTab: boolean;
  /** Per-status task counts for the status menu rows. */
  statusCounts?: Record<string, number>;
  query: string;
  onQueryChange: (value: string) => void;
  selectedCount: number;
  onClearSelection: () => void;
  onToggleExpandAll: () => void;
  allExpanded: boolean;
  status: Set<string>;
  onStatusChange: (next: Set<string>) => void;
  onSelect: (id: string) => void;
  onChange: (
    patch: Partial<Pick<ViewTab, "model" | "effort" | "since" | "provider" | "label">>,
  ) => void;
  /** Retire a model from the palette, or bring it back. */
  onSetArchived: (model: string, archived: boolean) => void;
  onDuplicate: () => void;
  onClose: (id: string) => void;
}) {
  const active = views.find((v) => v.id === activeViewId) ?? views[0]!;
  const activeModelFacet = facets.find((f) => f.model === active.model);
  // Effort is model-aware: only reveal the control for a specific model that
  // has 2+ distinct effort tiers in the data (option B).
  const effortOptions =
    active.model !== null && activeModelFacet && activeModelFacet.efforts.length > 1
      ? activeModelFacet.efforts
      : [];

  function changeModel(value: string) {
    const model = value === ALL_MODELS_VALUE ? null : value;
    // Clear effort if the new model no longer has it, so the view never
    // carries a filter the UI cannot show.
    const facet = facets.find((f) => f.model === model);
    const keepsEffort = facet ? facet.efforts.some((e) => e.effort === active.effort) : false;
    onChange({ model, effort: keepsEffort ? active.effort : null });
  }

  const trailingNode = (
    <div className="ml-auto flex items-center gap-3 text-[12px] text-muted-foreground">
      {isDerived && (
        <span className="font-mono text-[10px] text-muted-foreground/50">
          {loading ? "loading scoped stats…" : "scoped to this view"}
        </span>
      )}
      {selectedCount > 0 && (
        <>
          <button
            type="button"
            onClick={onClearSelection}
            className="underline-offset-2 hover:text-foreground/70 hover:underline"
          >
            <span className="font-medium text-foreground/70">{selectedCount}</span> selected
          </button>
          <div className="h-4 w-px bg-border" />
        </>
      )}
      <button type="button" onClick={onToggleExpandAll} className="hover:text-foreground/70">
        {allExpanded ? "Collapse all" : "Expand all"}
      </button>
    </div>
  );

  return (
    <div className="border-b border-border bg-muted/10">
      {/* Tabs: Main is permanent; every other tab is a closable derived copy.
          Hidden entirely for demo projects (no views there). */}
      {viewsActive && (
        <div className="flex flex-wrap items-stretch gap-1 bg-muted/20 px-6 py-2">
          {views.map((v) => {
            const isActive = v.id === activeViewId;
            const isMain = v.id === MAIN_VIEW_ID;
            return (
              // One bordered unit per tab: the select area + an inline close on
              // its right edge (Main has no close — it's permanent). Mirrors the
              // conventional editor/browser tab shape rather than a separate
              // close column.
              <div
                key={v.id}
                className={cn(
                  "flex items-stretch border transition-colors",
                  isActive
                    ? "border-foreground/40 bg-foreground/[0.08]"
                    : "border-foreground/15 hover:border-foreground/30 hover:bg-foreground/[0.05]",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect(v.id)}
                  className="relative flex flex-col items-start gap-0.5 px-3 py-1.5 text-left"
                >
                  {isActive && (
                    <span className="pointer-events-none absolute inset-y-1 left-0 w-[2px] bg-foreground" aria-hidden />
                  )}
                  <span className="flex items-center gap-1.5">
                    <span className={cn("text-[13px] font-medium", isActive ? "text-foreground" : "text-foreground/70")}>
                      {v.label}
                    </span>
                    {isMain && (
                      <span className="border border-foreground/25 px-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                        main
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">{viewConfigLabel(v)}</span>
                </button>
                {!isMain && (
                  <button
                    type="button"
                    aria-label={`Close ${v.label} tab`}
                    onClick={() => onClose(v.id)}
                    className="grid place-items-center border-l border-foreground/10 px-1.5 text-muted-foreground/50 hover:bg-destructive/20 hover:text-destructive"
                    title="Close tab"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}
          <button
            type="button"
            onClick={onDuplicate}
            disabled={addingTab}
            aria-label="Add a new view tab"
            className="grid place-items-center border border-dashed border-foreground/20 px-3 text-foreground/60 hover:border-foreground/40 hover:bg-foreground/[0.05] disabled:opacity-40"
            title="Add a new view tab (starts as a copy of the active one)"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* The shared filter row: search + status + model/effort/date cohort.
          Demo projects have no views, so the cohort controls hide there and
          only search + status remain. Status and search are URL-backed (the
          page owns the state); the cohort lives in the active view. */}
      <div className="border-t border-border px-6 py-2.5">
        <FilterBar
          statusOptions={TASK_STATUS_FILTERS.map((s) => ({
            ...s,
            count: statusCounts?.[s.value],
          }))}
          status={status}
          onStatusChange={onStatusChange}
          modelOptions={viewsActive ? facets : []}
          showModel={viewsActive}
          selectedModels={viewsActive && active.model ? new Set([active.model]) : new Set()}
          onSelectModel={(model) => changeModel(model === null ? ALL_MODELS_VALUE : model)}
          onSetArchived={onSetArchived}
          hostOptions={
            viewsActive && (active.model !== null || active.provider !== null)
              ? hostFacets
              : []
          }
          selectedHosts={viewsActive && active.provider ? new Set([active.provider]) : new Set()}
          onToggleHost={(host) =>
            onChange({ provider: active.provider === host ? null : host })
          }
          onClearHosts={() => onChange({ provider: null })}
          effortOptions={viewsActive ? effortOptions.map((e) => ({ value: e.effort, label: e.effort })) : []}
          effort={viewsActive ? active.effort : null}
          onEffortChange={(effort) => onChange({ effort })}
          since={viewsActive ? active.since : undefined}
          onSinceChange={viewsActive ? (since) => onChange({ since }) : undefined}
          query={query}
          onQueryChange={onQueryChange}
          searchPlaceholder="Filter tasks..."
          searchTestId="tasks-search-input"
          trailing={trailingNode}
        />
      </div>
    </div>
  );
}
