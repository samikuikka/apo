"use client";

// PROTOTYPE (throwaway) — variant `c`: cohort overview band. Views are
// really comparisons, so the cohorts render as a band of stat cards —
// "All history" plus one per model, each showing runs and a weighted pass
// rate — and clicking a card scopes the list. Effort and host refine the
// active card inline; saved views live in a "Shortcuts" dropdown. No
// competitor does this; it leans into apo's actual job (compare pass
// rates across models).

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Star, X } from "lucide-react";

import { TASK_STATUS_FILTERS } from "@/lib/filter-status";
import { fetchTaskHostFacets } from "@/lib/agent-task-view-api";
import { cn } from "@/lib/utils";

import { FolderList } from "../FolderList";
import { PassBar } from "../PassBar";
import { Menu, MenuLabel, MenuRow } from "./proto-kit";
import {
  cohortIsEmpty,
  cohortKey,
  cohortSummary,
  EMPTY_COHORT,
  SINCE_OPTIONS,
  statusCountsOf,
  useFolderView,
  useViewsProtoState,
  type VariantProps,
} from "./proto-state";
import { aggregateTotals, applyStats, useCohortStats } from "./use-cohort-stats";

export function VariantC({ projectId, tasks, facets, seedViews }: VariantProps) {
  const state = useViewsProtoState(seedViews);
  const { cohort } = state;

  // Every model card needs its cohort stats; the active cohort may add
  // effort/host/since refinements on top.
  const cardCohorts = useMemo(
    () => facets.filter((f) => !f.archived).map((f) => ({ ...EMPTY_COHORT, model: f.model })),
    [facets],
  );
  const { statsByKey, loading } = useCohortStats(projectId, [...cardCohorts, cohort]);
  const scopedTasks = useMemo(
    () => applyStats(tasks, cohortIsEmpty(cohort) ? undefined : statsByKey[cohortKey(cohort)]),
    [tasks, cohort, statsByKey],
  );
  const fv = useFolderView(scopedTasks, state);
  const statusCounts = useMemo(() => statusCountsOf(scopedTasks), [scopedTasks]);

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

  const allTotals = useMemo(() => aggregateTotals(tasks, undefined), [tasks]);
  const activeStatusLabels = TASK_STATUS_FILTERS.filter((s) => state.statusFilter.has(s.value)).map(
    (s) => s.label,
  );

  function selectModel(model: string | null) {
    state.setCohort({ model, effort: null, provider: null });
  }

  return (
    <>
      {/* Cohort band: one card per cohort, click to scope. */}
      <div className="flex flex-wrap items-stretch gap-2 border-b border-border bg-muted/10 px-6 py-3">
        <button
          type="button"
          onClick={() => selectModel(null)}
          className={cn(
            "min-w-[170px] border px-3 py-2 text-left transition-colors",
            cohort.model === null
              ? "border-foreground/50 bg-foreground/[0.06]"
              : "border-border hover:border-foreground/30 hover:bg-foreground/[0.03]",
          )}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[13px] font-medium">All history</span>
            <span className="font-mono text-[11px] text-muted-foreground">{allTotals.runs} runs</span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <PassBar value={allTotals.passRate ?? 0} muted={allTotals.passRate === null} />
          </div>
        </button>

        {facets
          .filter((f) => !f.archived)
          .map((f) => {
            const totals = aggregateTotals(tasks, statsByKey[cohortKey({ ...EMPTY_COHORT, model: f.model })]);
            const isActive = cohort.model === f.model;
            return (
              <div
                key={f.model}
                className={cn(
                  "min-w-[190px] border px-3 py-2 transition-colors",
                  isActive
                    ? "border-foreground/50 bg-foreground/[0.06]"
                    : "border-border hover:border-foreground/30 hover:bg-foreground/[0.03]",
                )}
              >
                <button type="button" onClick={() => selectModel(f.model)} className="w-full text-left">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={cn("truncate text-[13px] font-medium", !isActive && "text-foreground/80")}>
                      {f.model}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">{f.count} runs</span>
                  </div>
                  <div className="mt-1.5">
                    <PassBar
                      value={totals.passRate ?? 0}
                      muted={totals.passRate === null && !loading}
                    />
                  </div>
                </button>
                {isActive && (f.efforts.length > 1 || hostFacets.length > 1) && (
                  <div className="mt-2 flex flex-wrap gap-1 border-t border-border/60 pt-2">
                    {f.efforts.length > 1 && (
                      <>
                        <button
                          type="button"
                          onClick={() => state.setCohort({ effort: null })}
                          className={cn(
                            "border px-1.5 py-0.5 font-mono text-[10px]",
                            cohort.effort === null
                              ? "border-foreground/40 text-foreground"
                              : "border-border text-muted-foreground hover:text-foreground",
                          )}
                        >
                          any effort
                        </button>
                        {f.efforts.map((e) => (
                          <button
                            key={e.effort}
                            type="button"
                            onClick={() => state.setCohort({ effort: e.effort })}
                            className={cn(
                              "border px-1.5 py-0.5 font-mono text-[10px]",
                              cohort.effort === e.effort
                                ? "border-foreground/40 text-foreground"
                                : "border-border text-muted-foreground hover:text-foreground",
                            )}
                          >
                            {e.effort} · {e.count}
                          </button>
                        ))}
                      </>
                    )}
                    {hostFacets.length > 1 &&
                      hostFacets.map((h) => (
                        <button
                          key={h.label}
                          type="button"
                          onClick={() => state.setCohort({ provider: cohort.provider === h.label ? null : h.label })}
                          className={cn(
                            "border px-1.5 py-0.5 font-mono text-[10px]",
                            cohort.provider === h.label
                              ? "border-foreground/40 text-foreground"
                              : "border-border text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {h.label}
                        </button>
                      ))}
                  </div>
                )}
              </div>
            );
          })}

        <div className="ml-auto flex flex-col items-end justify-center gap-1 text-xs text-muted-foreground">
          <Menu
            align="right"
            panelClassName="w-44"
            ariaLabel="Time window"
            button={
              <>
                <span>{cohort.since ? `Last ${cohort.since}` : "All time"}</span>
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </>
            }
          >
            {(close) => (
              <>
                <MenuLabel>Since</MenuLabel>
                <MenuRow
                  active={cohort.since === null}
                  onClick={() => {
                    state.setCohort({ since: null });
                    close();
                  }}
                >
                  <span className="flex-1">All time</span>
                  {cohort.since === null && <Check className="h-3 w-3" />}
                </MenuRow>
                {SINCE_OPTIONS.map((s) => (
                  <MenuRow
                    key={s}
                    active={cohort.since === s}
                    onClick={() => {
                      state.setCohort({ since: s });
                      close();
                    }}
                  >
                    <span className="flex-1">Last {s}</span>
                    {cohort.since === s && <Check className="h-3 w-3" />}
                  </MenuRow>
                ))}
              </>
            )}
          </Menu>
          <Menu
            align="right"
            panelClassName="w-64"
            ariaLabel="Saved view shortcuts"
            button={
              <>
                <span>Shortcuts</span>
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </>
            }
          >
            {(close) => (
              <>
                <MenuLabel>Saved views</MenuLabel>
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
                      <span className="truncate text-foreground/80">{v.label}</span>
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
              </>
            )}
          </Menu>
        </div>
      </div>

      {/* List controls row. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-2">
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
                    <span className="font-mono text-[11px] text-muted-foreground">{statusCounts[s.value] ?? 0}</span>
                    {active && <Check className="h-3 w-3" />}
                  </MenuRow>
                );
              })}
            </>
          )}
        </Menu>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {!cohortIsEmpty(cohort) && (
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
