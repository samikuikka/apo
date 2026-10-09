"use client";

// PROTOTYPE (throwaway) — variant `b`: minimal tabs (GitHub Projects
// pattern, decluttered). The tab metaphor stays but collapses from two
// rows to one: name-only pills, close on hover, "+" duplicates, and all
// cohort configuration behind a single gear popover. Tests whether the
// concept is right and only today's chrome weight is wrong.

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Plus, Settings2, X } from "lucide-react";

import { TASK_STATUS_FILTERS } from "@/lib/filter-status";
import { fetchTaskHostFacets } from "@/lib/agent-task-view-api";
import { cn } from "@/lib/utils";

import { FolderList } from "../FolderList";
import { Menu, MenuLabel, MenuRow } from "./proto-kit";
import {
  cohortIsEmpty,
  cohortKey,
  SINCE_OPTIONS,
  statusCountsOf,
  useFolderView,
  useViewsProtoState,
  type VariantProps,
} from "./proto-state";
import { applyStats, useCohortStats } from "./use-cohort-stats";

export function VariantB({ projectId, tasks, facets, seedViews }: VariantProps) {
  const state = useViewsProtoState(seedViews);
  const { cohort } = state;
  const { statsByKey, loading } = useCohortStats(projectId, [cohort]);
  const scopedTasks = useMemo(
    () => applyStats(tasks, cohortIsEmpty(cohort) ? undefined : statsByKey[cohortKey(cohort)]),
    [tasks, cohort, statsByKey],
  );
  const fv = useFolderView(scopedTasks, state);
  const statusCounts = useMemo(() => statusCountsOf(scopedTasks), [scopedTasks]);
  const scoped = !cohortIsEmpty(cohort);

  const modelFacet = facets.find((f) => f.model === cohort.model);
  const effortOptions =
    cohort.model !== null && modelFacet && modelFacet.efforts.length > 1
      ? modelFacet.efforts
      : [];

  const [hostFacets, setHostFacets] = useState<{ label: string; count: number }[]>([]);
  useEffect(() => {
    if (!cohort.model) {
      setHostFacets([]);
      return;
    }
    const controller = new AbortController();
    fetchTaskHostFacets(projectId, controller.signal, cohort.model)
      .then((f) => setHostFacets(f))
      .catch(() => {});
    return () => controller.abort();
  }, [projectId, cohort.model]);

  const activeStatusLabels = TASK_STATUS_FILTERS.filter((s) => state.statusFilter.has(s.value)).map(
    (s) => s.label,
  );

  function changeModel(model: string | null) {
    const facet = facets.find((f) => f.model === model);
    const keepsEffort = facet ? facet.efforts.some((e) => e.effort === cohort.effort) : false;
    state.setCohort({ model, effort: keepsEffort ? cohort.effort : null, provider: null });
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/10 px-6 py-2">
        {state.views.map((v) => {
          const isActive = v.id === state.activeId;
          return (
            <div
              key={v.id}
              className={cn(
                "group/tab flex h-7 items-stretch border transition-colors",
                isActive
                  ? "border-foreground/40 bg-foreground/[0.08]"
                  : "border-foreground/15 hover:border-foreground/30 hover:bg-foreground/[0.05]",
              )}
            >
              <button
                type="button"
                onClick={() => state.setActiveId(v.id)}
                className="flex items-center gap-1.5 px-2.5 text-xs"
                title={v.label}
              >
                <span className={cn("max-w-[140px] truncate", isActive ? "text-foreground" : "text-foreground/70")}>
                  {v.label}
                </span>
                {state.isDirty && isActive && (
                  <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-label="Unsaved changes" />
                )}
              </button>
              {v.id !== "main" && (
                <button
                  type="button"
                  aria-label={`Close ${v.label} tab`}
                  onClick={() => state.removeView(v.id)}
                  className="grid place-items-center border-l border-foreground/10 px-1.5 text-muted-foreground/50 opacity-0 transition-opacity hover:bg-destructive/20 hover:text-destructive group-hover/tab:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => state.saveAsNew(`View ${state.views.length}`)}
          aria-label="Add a new view tab (copy of the active one)"
          className="grid h-7 place-items-center border border-dashed border-foreground/20 px-2 text-foreground/60 hover:border-foreground/40 hover:bg-foreground/[0.05]"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>

        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {scoped && (
            <span className="font-mono text-[10px] text-muted-foreground/50">
              {loading ? "loading scoped stats…" : "scoped"}
            </span>
          )}
          <Menu
            button={
              <>
                <Settings2 className="h-3 w-3" />
                <span>Config</span>
                {state.isDirty && <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-label="Unsaved changes" />}
              </>
            }
            panelClassName="w-64"
            ariaLabel="Configure the active view"
          >
            {() => (
              <>
                {state.activeId !== "main" && (
                  <div className="px-1 pb-1.5">
                    <input
                      value={state.active.label}
                      onChange={(e) => state.renameActive(e.target.value)}
                      aria-label="View name"
                      className="h-7 w-full border border-border bg-input/30 px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                )}
                <MenuLabel>Model</MenuLabel>
                <MenuRow onClick={() => changeModel(null)} active={cohort.model === null}>
                  <span className="flex-1">All models</span>
                  {cohort.model === null && <Check className="h-3 w-3" />}
                </MenuRow>
                {facets
                  .filter((f) => !f.archived)
                  .map((f) => (
                    <MenuRow key={f.model} onClick={() => changeModel(f.model)} active={cohort.model === f.model}>
                      <span className="flex-1 truncate">{f.model}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{f.count}</span>
                    </MenuRow>
                  ))}
                {effortOptions.length > 0 && (
                  <>
                    <MenuLabel>Effort</MenuLabel>
                    <MenuRow onClick={() => state.setCohort({ effort: null })} active={cohort.effort === null}>
                      <span className="flex-1">Any</span>
                    </MenuRow>
                    {effortOptions.map((e) => (
                      <MenuRow key={e.effort} active={cohort.effort === e.effort} onClick={() => state.setCohort({ effort: e.effort })}>
                        <span className="flex-1">{e.effort}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">{e.count}</span>
                      </MenuRow>
                    ))}
                  </>
                )}
                <MenuLabel>Since</MenuLabel>
                <MenuRow onClick={() => state.setCohort({ since: null })} active={cohort.since === null}>
                  <span className="flex-1">All time</span>
                </MenuRow>
                {SINCE_OPTIONS.map((s) => (
                  <MenuRow key={s} active={cohort.since === s} onClick={() => state.setCohort({ since: s })}>
                    <span className="flex-1">Last {s}</span>
                  </MenuRow>
                ))}
                {cohort.model !== null && hostFacets.length > 0 && (
                  <>
                    <MenuLabel>Host</MenuLabel>
                    <MenuRow onClick={() => state.setCohort({ provider: null })} active={cohort.provider === null}>
                      <span className="flex-1">Any host</span>
                    </MenuRow>
                    {hostFacets.map((h) => (
                      <MenuRow key={h.label} active={cohort.provider === h.label} onClick={() => state.setCohort({ provider: h.label })}>
                        <span className="flex-1 truncate">{h.label}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">{h.count}</span>
                      </MenuRow>
                    ))}
                  </>
                )}
                {state.isDirty && (
                  <div className="mt-1 flex items-center gap-1 border-t border-border px-1 pt-1.5">
                    <button
                      type="button"
                      onClick={state.resetCohort}
                      className="h-7 flex-1 border border-border px-2 text-xs text-muted-foreground hover:text-foreground"
                    >
                      Reset
                    </button>
                    {state.activeId !== "main" ? (
                      <button
                        type="button"
                        onClick={state.commitActive}
                        className="h-7 flex-1 border border-foreground/40 bg-foreground/[0.08] px-2 text-xs text-foreground hover:bg-foreground/[0.12]"
                      >
                        Save
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => state.saveAsNew(`View ${state.views.length}`)}
                        className="h-7 flex-1 border border-foreground/40 bg-foreground/[0.08] px-2 text-xs text-foreground hover:bg-foreground/[0.12]"
                      >
                        Save As View
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </Menu>
          <Menu
            button={
              <>
                <span className={state.statusFilter.size > 0 ? "text-foreground" : undefined}>
                  {state.statusFilter.size > 0 ? activeStatusLabels.join(", ") : "Status"}
                </span>
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </>
            }
            panelClassName="w-52"
            ariaLabel="Filter by status"
          >
            {() => (
              <>
                <MenuLabel>Status</MenuLabel>
                {TASK_STATUS_FILTERS.map((s) => {
                  const active = state.statusFilter.has(s.value);
                  return (
                    <MenuRow
                      key={s.value}
                      active={active}
                      onClick={() => {
                        const next = new Set(state.statusFilter);
                        if (next.has(s.value)) next.delete(s.value);
                        else next.add(s.value);
                        state.setStatusFilter(next);
                      }}
                    >
                      <span className={cn("h-2 w-2 rounded-full", s.dot)} aria-hidden />
                      <span className="flex-1">{s.label}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{statusCounts[s.value] ?? 0}</span>
                      {active && <Check className="h-3 w-3" />}
                    </MenuRow>
                  );
                })}
              </>
            )}
          </Menu>
          <input
            value={state.query}
            onChange={(e) => state.setQuery(e.target.value)}
            placeholder="Filter tasks…"
            aria-label="Filter tasks"
            className="h-7 w-44 border border-border bg-input/30 px-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {fv.selected.size > 0 && (
            <button type="button" onClick={fv.clearSelection} className="underline-offset-2 hover:text-foreground/70 hover:underline">
              <span className="font-medium text-foreground/70">{fv.selected.size}</span> selected
            </button>
          )}
          <button type="button" onClick={fv.toggleExpandAll} className="hover:text-foreground/70">
            {fv.allExpanded ? "Collapse all" : "Expand all"}
          </button>
        </div>
      </div>

      <FolderList
        folders={fv.folders}
        expanded={fv.expanded}
        selected={fv.selected}
        query={state.query}
        selectAllState={fv.selectAllState}
        visibleTaskCount={fv.visibleTaskIds.length}
        onToggleSelectAll={fv.toggleSelectAll}
        onToggleFolder={fv.toggleFolder}
        onToggleTask={fv.toggleTask}
        onToggleExpand={fv.toggleExpand}
      />
    </>
  );
}
