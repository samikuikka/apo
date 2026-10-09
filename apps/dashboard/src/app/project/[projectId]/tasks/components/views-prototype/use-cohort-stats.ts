"use client";

// PROTOTYPE (throwaway) — per-cohort scoped stats for the views-prototype
// variants. GET-only; never writes a saved view.

import { useEffect, useState } from "react";

import type { AgentTaskRunStats, AgentTaskSummary } from "@/lib/agent-task-api";
import { fetchTaskViewStats } from "@/lib/agent-task-view-api";

import { cohortKey, type Cohort } from "./proto-state";

export type CohortStatsMap = Record<string, Record<string, AgentTaskRunStats>>;

/**
 * Stats overlays for a set of cohorts, keyed by `cohortKey`. The empty cohort
 * maps to the server-provided `run_stats` on each task (no fetch), matching
 * the Main tab semantics.
 */
export function useCohortStats(
  projectId: string,
  cohorts: Cohort[],
): { statsByKey: CohortStatsMap; loading: boolean } {
  // The empty cohort's "overlay" is the original tasks; callers treat a
  // missing key for it as "use originals".
  const fetchable = cohorts.filter((c) => c.model !== null || c.effort !== null || c.since !== null || c.provider !== null);
  const keys = fetchable.map(cohortKey).join("§");

  const [statsByKey, setStatsByKey] = useState<CohortStatsMap>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (fetchable.length === 0) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    Promise.all(
      fetchable.map((c) =>
        fetchTaskViewStats(projectId, c.model, c.effort, c.since, controller.signal, c.provider)
          .then((stats) => [cohortKey(c), stats] as const)
          .catch(() => [cohortKey(c), {}] as const),
      ),
    ).then((entries) => {
      if (cancelled) return;
      setStatsByKey(Object.fromEntries(entries));
      setLoading(false);
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keys string is the identity
  }, [projectId, keys]);

  return { statsByKey, loading };
}

/** Tasks with a cohort's stats overlaid (empty overlay = originals). */
export function applyStats(
  tasks: AgentTaskSummary[],
  stats: Record<string, AgentTaskRunStats> | undefined,
): AgentTaskSummary[] {
  if (!stats) return tasks;
  return tasks.map((t) => ({ ...t, run_stats: stats[t.id] ?? null }));
}

export interface CohortTotals {
  runs: number;
  /** Run-weighted pass rate in [0,1]; null when no runs. */
  passRate: number | null;
  lastRunAt: string | null;
}

/** Aggregate a cohort's per-task stats into card totals (variant c). */
export function aggregateTotals(
  tasks: AgentTaskSummary[],
  stats: Record<string, AgentTaskRunStats> | undefined,
): CohortTotals {
  const scoped = applyStats(tasks, stats);
  let runs = 0;
  let passedWeighted = 0;
  let lastRunAt: string | null = null;
  for (const t of scoped) {
    const s = t.run_stats;
    if (!s || s.total_runs <= 0) continue;
    runs += s.total_runs;
    passedWeighted += s.pass_rate * s.total_runs;
    if (s.last_run_at && (!lastRunAt || s.last_run_at > lastRunAt)) lastRunAt = s.last_run_at;
  }
  return {
    runs,
    passRate: runs > 0 ? passedWeighted / runs : null,
    lastRunAt,
  };
}
