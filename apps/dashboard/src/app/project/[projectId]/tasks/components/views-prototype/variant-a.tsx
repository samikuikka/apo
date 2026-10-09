"use client";

// PROTOTYPE (throwaway) — variant `a`: filter bar + views menu
// (Datadog/Linear pattern). No tab strip. One row of live controls —
// search, status menu, cohort chips, a "Filter +" popover — and a Views
// dropdown that treats saved views as bookmarks of the current filter
// state. Unsaved edits show a dirty dot (GitHub-style); views can be
// starred, applied, deleted, and created from the current state.

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Plus, Star, X } from "lucide-react";

import { TASK_STATUS_FILTERS } from "@/lib/filter-status";
import { fetchTaskHostFacets } from "@/lib/agent-task-view-api";
import { cn } from "@/lib/utils";

import { FolderList } from "../FolderList";
import { Chip, Menu, MenuLabel, MenuRow } from "./proto-kit";
import {
  cohortIsEmpty,
  cohortKey,
  cohortSummary,
  SINCE_OPTIONS,
  statusCountsOf,
  useFolderView,
  useViewsProtoState,
  type VariantProps,
} from "./proto-state";
import { applyStats, useCohortStats } from "./use-cohort-stats";

export function VariantA({ projectId, tasks, facets, seedViews }: VariantProps) {
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

  const activeStatusLabels = TASK_STATUS_FILTERS.filter((s) =>
    state.statusFilter.has(s.value),
  ).map((s) => s.label);
  const [saveName, setSaveName] = useState("");

  function changeModel(model: string | null) {
    const facet = facets.find((f) => f.model === model);
    const keepsEffort = facet ? facet.efforts.some((e) => e.effort === cohort.effort) : false;
    state.setCohort({ model, effort: keepsEffort ? cohort.effort : null, provider: null });
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/10 px-6 py-2.5">
        <input
          value={state.query}
          onChange={(e) => state.setQuery(e.target.value)}
          placeholder="Filter tasks…"
          aria-label="Filter tasks"
          className="h-8 w-52 border border-border bg-input/30 px-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
        />

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
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {statusCounts[s.value] ?? 0}
                    </span>
                    {active && <Check className="h-3 w-3 text-foreground" />}
                  </MenuRow>
                );
              })}
            </>
          )}
        </Menu>

        {cohort.model !== null && (
          <Chip label={`model: ${cohort.model}`} onRemove={() => changeModel(null)} tone="active" />
        )}
        {cohort.effort !== null && (
          <Chip label={`effort: ${cohort.effort}`} onRemove={() => state.setCohort({ effort: null })} />
        )}
        {cohort.since !== null && (
          <Chip label={`since: ${cohort.since}`} onRemove={() => state.setCohort({ since: null })} />
        )}
        {cohort.provider !== null && (
          <Chip label={`host: ${cohort.provider}`} onRemove={() => state.setCohort({ provider: null })} />
        )}

        <Menu
          button={
            <>
              <Plus className="h-3 w-3" />
              <span>Filter</span>
            </>
          }
          panelClassName="w-64"
          ariaLabel="Add a cohort filter"
        >
          {() => (
            <>
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
                    {cohort.model === f.model && <Check className="h-3 w-3" />}
                  </MenuRow>
                ))}
              {effortOptions.length > 0 && (
                <>
                  <MenuLabel>Effort</MenuLabel>
                  <MenuRow onClick={() => state.setCohort({ effort: null })} active={cohort.effort === null}>
                    <span className="flex-1">Any</span>
                  </MenuRow>
                  {effortOptions.map((e) => (
                    <MenuRow
                      key={e.effort}
                      active={cohort.effort === e.effort}
                      onClick={() => state.setCohort({ effort: e.effort })}
                    >
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
                    <MenuRow
                      key={h.label}
                      active={cohort.provider === h.label}
                      onClick={() => state.setCohort({ provider: h.label })}
                    >
                      <span className="flex-1 truncate">{h.label}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{h.count}</span>
                    </MenuRow>
                  ))}
                </>
              )}
            </>
          )}
        </Menu>

        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {scoped && (
            <span className="font-mono text-[10px] text-muted-foreground/50">
              {loading ? "loading scoped stats…" : "scoped"}
            </span>
          )}
          {fv.selected.size > 0 && (
            <>
              <button
                type="button"
                onClick={fv.clearSelection}
                className="underline-offset-2 hover:text-foreground/70 hover:underline"
              >
                <span className="font-medium text-foreground/70">{fv.selected.size}</span> selected
              </button>
              <span className="h-4 w-px bg-border" aria-hidden />
            </>
          )}
          <button type="button" onClick={fv.toggleExpandAll} className="hover:text-foreground/70">
            {fv.allExpanded ? "Collapse all" : "Expand all"}
          </button>
          {state.isDirty && (
            <>
              <span className="h-4 w-px bg-border" aria-hidden />
              <button type="button" onClick={state.resetCohort} className="hover:text-foreground/70">
                Reset
              </button>
              {state.activeId !== "main" && (
                <button type="button" onClick={state.commitActive} className="text-foreground underline-offset-2 hover:underline">
                  Save
                </button>
              )}
            </>
          )}
          <Menu
            align="right"
            panelClassName="w-72"
            ariaLabel="Saved views"
            button={
              <>
                <span>Views</span>
                {state.isDirty && <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-label="Unsaved changes" />}
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </>
            }
          >
            {(close) => (
              <>
                <MenuLabel>Views</MenuLabel>
                {state.views.map((v) => (
                  <div
                    key={v.id}
                    className={cn(
                      "group flex items-center gap-1 px-2 py-1.5 text-xs hover:bg-accent",
                      v.id === state.activeId && "bg-accent",
                    )}
                  >
                    <button
                      type="button"
                      aria-label={v.starred ? `Unstar ${v.label}` : `Star ${v.label}`}
                      onClick={() => state.toggleStar(v.id)}
                      className={cn(
                        "shrink-0 hover:text-foreground",
                        v.starred ? "text-warning" : "text-muted-foreground/40",
                      )}
                    >
                      <Star className={cn("h-3 w-3", v.starred && "fill-current")} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        state.setActiveId(v.id);
                        close();
                      }}
                      className="flex min-w-0 flex-1 flex-col items-start"
                    >
                      <span className={cn("truncate", v.id === state.activeId ? "text-foreground" : "text-foreground/80")}>
                        {v.label}
                        {v.id === "main" && (
                          <span className="ml-1.5 border border-foreground/25 px-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                            all history
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">{cohortSummary(v.cohort)}</span>
                    </button>
                    {v.id !== "main" && (
                      <button
                        type="button"
                        aria-label={`Delete ${v.label}`}
                        onClick={() => state.removeView(v.id)}
                        className="text-muted-foreground/40 opacity-0 hover:text-destructive group-hover:opacity-100"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                ))}
                <div className="mt-1 border-t border-border pt-1.5">
                  <MenuLabel>Save current filters as view</MenuLabel>
                  <div className="flex items-center gap-1 px-1 pb-1">
                    <input
                      value={saveName}
                      onChange={(e) => setSaveName(e.target.value)}
                      placeholder={`View ${state.views.length}`}
                      aria-label="Name for the new view"
                      className="h-7 flex-1 border border-border bg-input/30 px-2 text-xs placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        state.saveAsNew(saveName || `View ${state.views.length}`);
                        setSaveName("");
                        close();
                      }}
                      className="h-7 border border-foreground/40 bg-foreground/[0.08] px-2 text-xs text-foreground hover:bg-foreground/[0.12]"
                    >
                      Save
                    </button>
                  </div>
                </div>
              </>
            )}
          </Menu>
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
