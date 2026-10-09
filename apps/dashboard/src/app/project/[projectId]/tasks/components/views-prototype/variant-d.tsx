"use client";

// PROTOTYPE (throwaway) — variant `d` (round 2): the comparison IS the
// page. Tasks are rows, models are columns, each cell is a filled color
// block showing that task's pass rate under that model. No view chrome.
// When the project's real data is too sparse to show the design, a clearly
// labeled demo-data mode fills the grid with deterministic generated rates
// (a border-warning chip toggles it; it never pretends to be real).

import { useMemo, useState } from "react";
import Link from "next/link";

import type { AgentTaskRunStats, AgentTaskSummary } from "@/lib/agent-task-api";
import type { RunConfigModelFacet } from "@/lib/agent-task-view-api";
import { cn } from "@/lib/utils";
import { hrefWithRunCohort } from "@/lib/run-cohort";
import { taskDetailHref } from "@/lib/task-routes";
import { groupByFolder } from "../task-list-shared";

import { cohortKey, EMPTY_COHORT } from "./proto-state";
import { useCohortStats } from "./use-cohort-stats";

/** "vendor/model-name" → "model-name", disambiguated on collision. */
function shortModelNames(models: string[]): Map<string, string> {
  const byShort = new Map<string, string[]>();
  for (const m of models) {
    const short = m.split("/").pop() ?? m;
    byShort.set(short, [...(byShort.get(short) ?? []), m]);
  }
  const names = new Map<string, string>();
  for (const [short, fulls] of byShort) {
    if (fulls.length === 1) {
      names.set(fulls[0]!, short);
    } else {
      for (const f of fulls) names.set(f, f); // collision: keep the full name
    }
  }
  return names;
}

/** Deterministic 0..1 hash so demo data never flickers between renders. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function demoRate(taskId: string, model: string): number | null {
  const h = hash01(`${taskId}::${model}`);
  if (h < 0.08) return null; // a few "never ran under this model" holes
  const v = hash01(`${model}::${taskId}`);
  if (v < 0.45) return 0.85 + h * 0.15;
  if (v < 0.75) return 0.5 + h * 0.35;
  return h * 0.5;
}

function toneFor(pct: number): string {
  if (pct >= 80) return "text-success";
  if (pct < 50) return "text-destructive";
  return "text-warning";
}

function cellTone(pct: number): string {
  if (pct >= 80) return "border-success/40 bg-success/10";
  if (pct < 50) return "border-destructive/40 bg-destructive/10";
  return "border-warning/40 bg-warning/10";
}

export function VariantD({ projectId, tasks, facets }: {
  projectId: string;
  tasks: AgentTaskSummary[];
  facets: RunConfigModelFacet[];
  seedViews: unknown[];
}) {
  const [query, setQuery] = useState("");
  const models = useMemo(() => facets.filter((f) => !f.archived), [facets]);
  const modelCohorts = useMemo(
    () => models.map((f) => ({ ...EMPTY_COHORT, model: f.model })),
    [models],
  );
  const { statsByKey, loading } = useCohortStats(projectId, modelCohorts);

  const realRates = useMemo(() => {
    // [taskId][model] → rate | null, from the real per-model overlays.
    const map = new Map<string, Map<string, number | null>>();
    for (const t of tasks) {
      const perModel = new Map<string, number | null>();
      for (const f of models) {
        const s = statsByKey[cohortKey({ ...EMPTY_COHORT, model: f.model })]?.[t.id];
        perModel.set(f.model, s && s.total_runs > 0 ? s.pass_rate : null);
      }
      map.set(t.id, perModel);
    }
    return map;
  }, [tasks, models, statsByKey]);

  // A model column only earns its place with at least one catalog run.
  const modelsWithRuns = useMemo(
    () => models.filter((f) => [...realRates.values()].some((m) => m.get(f.model) !== null)),
    [models, realRates],
  );
  const hiddenModels = models.filter((f) => !modelsWithRuns.includes(f));

  // Real cells this sparse cannot show the design; start in demo mode then.
  const realFilled =
    modelsWithRuns.length > 0
      ? [...realRates.values()].reduce((n, m) => n + [...m.values()].filter((v) => v !== null).length, 0)
      : 0;
  const sparse = realFilled < Math.max(4, Math.floor((tasks.length * models.length) / 4));
  const [demo, setDemo] = useState(sparse);

  const shownModels = demo ? models : modelsWithRuns;
  const columnCount = shownModels.length + 2;
  const shortNames = useMemo(() => shortModelNames(shownModels.map((f) => f.model)), [shownModels]);

  const allSub = useMemo(() => {
    let runs = 0;
    let weighted = 0;
    for (const t of tasks) {
      const rate = demo ? demoRate(t.id, "__all__") : t.run_stats && t.run_stats.total_runs > 0 ? t.run_stats.pass_rate : null;
      if (rate === null) continue;
      const n = demo ? 1 + Math.floor(hash01(`${t.id}#all`) * 5) : t.run_stats!.total_runs;
      runs += n;
      weighted += rate * n;
    }
    if (runs === 0) return { line: "0 runs", tone: undefined };
    const pct = Math.round((weighted / runs) * 100);
    return { line: `${runs} runs · ${pct}%`, tone: toneFor(pct) };
  }, [tasks, demo]);

  const q = query.toLowerCase();
  const folders = useMemo(() => {
    const grouped = groupByFolder(tasks);
    if (!q) return grouped;
    return grouped.reduce<typeof grouped>((acc, f) => {
      const fTasks = f.tasks.filter(
        (t) =>
          t.display_name.toLowerCase().includes(q) ||
          t.task_path.toLowerCase().includes(q) ||
          f.id.toLowerCase().includes(q),
      );
      if (fTasks.length > 0) acc.push({ ...f, tasks: fTasks });
      return acc;
    }, []);
  }, [tasks, q]);

  const rateFor = (task: AgentTaskSummary, model: string | null): number | null => {
    if (model === null) {
      const all = task.run_stats;
      if (demo) return demoRate(task.id, "__all__");
      return all && all.total_runs > 0 ? all.pass_rate : null;
    }
    if (demo) return demoRate(task.id, model);
    return realRates.get(task.id)?.get(model) ?? null;
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/10 px-6 py-2.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter tasks…"
          aria-label="Filter tasks"
          className="h-8 w-52 border border-border bg-input/30 px-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <span className="text-[11px] text-muted-foreground">
          {tasks.length} tasks · {shownModels.length} models
          {loading && !demo ? " · loading…" : ""}
        </span>
        {hiddenModels.length > 0 && !demo && (
          <span className="text-[11px] text-muted-foreground/60" title={hiddenModels.map((f) => f.model).join(", ")}>
            ({hiddenModels.length} more models with no runs on catalog tasks)
          </span>
        )}
        {demo && (
          <button
            type="button"
            onClick={() => setDemo(false)}
            className="h-6 border border-warning/50 px-2 text-[10px] uppercase tracking-wide text-warning hover:bg-warning/10"
            title="This project's catalog runs are sparse; the grid currently shows generated pass rates. Click to see the real data."
          >
            demo data — click for real
          </button>
        )}
        {!demo && sparse && (
          <button
            type="button"
            onClick={() => setDemo(true)}
            className="h-6 border border-border px-2 text-[10px] uppercase tracking-wide text-muted-foreground hover:border-foreground/30 hover:text-foreground"
          >
            show demo data
          </button>
        )}
      </div>

      <div className="overflow-x-auto px-6 py-4">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 z-20 min-w-[230px] border-b border-border bg-background px-2 py-2 text-left font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Task
              </th>
              <ColumnHeader label="All" title="All history" sub={allSub.line} subTone={allSub.tone} />
              {shownModels.map((f) => {
                const totals = columnTotals(
                  tasks,
                  demo ? undefined : statsByKey[cohortKey({ ...EMPTY_COHORT, model: f.model })],
                  demo,
                  f.model,
                );
                return (
                  <ColumnHeader
                    key={f.model}
                    label={shortNames.get(f.model) ?? f.model}
                    title={f.model}
                    sub={`${totals.runs} runs${totals.passRate !== null ? ` · ${Math.round(totals.passRate * 100)}%` : ""}`}
                    subTone={totals.passRate !== null ? toneFor(Math.round(totals.passRate * 100)) : undefined}
                  />
                );
              })}
            </tr>
          </thead>
          <tbody>
            {folders.map((folder) => (
              <FolderSection
                key={folder.id}
                label={folder.id === "(root)" ? "Root" : folder.id}
                tasks={folder.tasks}
                models={shownModels.map((f) => f.model)}
                projectId={projectId}
                columnCount={columnCount}
                rateFor={rateFor}
              />
            ))}
            {folders.length === 0 && (
              <tr>
                <td colSpan={columnCount} className="px-2 py-10 text-center text-muted-foreground">
                  No tasks match <span className="font-mono text-foreground/70">&quot;{query}&quot;</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function columnTotals(
  tasks: AgentTaskSummary[],
  stats: Record<string, AgentTaskRunStats> | undefined,
  demo: boolean,
  model: string,
): { runs: number; passRate: number | null } {
  let runs = 0;
  let weighted = 0;
  for (const t of tasks) {
    const rate = demo
      ? demoRate(t.id, model)
      : stats?.[t.id] && stats[t.id]!.total_runs > 0
        ? stats[t.id]!.pass_rate
        : null;
    const n = demo ? 1 + Math.floor(hash01(`${t.id}#${model}`) * 5) : (stats?.[t.id]?.total_runs ?? 0);
    if (rate === null) continue;
    runs += n;
    weighted += rate * n;
  }
  return { runs, passRate: runs > 0 ? weighted / runs : null };
}

function ColumnHeader({
  label,
  title,
  sub,
  subTone,
}: {
  label: string;
  title: string;
  sub: string | null;
  subTone?: string;
}) {
  return (
    <th className="sticky top-0 z-10 whitespace-nowrap border-b border-l border-border bg-background px-2 py-2 text-center">
      <span className="block text-[12px] font-medium text-foreground/90" title={title}>
        {label}
      </span>
      {sub && (
        <span className={cn("block font-mono text-[10px] tabular-nums text-muted-foreground", subTone)}>{sub}</span>
      )}
    </th>
  );
}

function FolderSection({
  label,
  tasks,
  models,
  projectId,
  columnCount,
  rateFor,
}: {
  label: string;
  tasks: AgentTaskSummary[];
  models: string[];
  projectId: string;
  columnCount: number;
  rateFor: (task: AgentTaskSummary, model: string | null) => number | null;
}) {
  return (
    <>
      <tr>
        <td
          colSpan={columnCount}
          className="border-b border-border px-2 py-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
        >
          {label} <span className="text-muted-foreground/60">· {tasks.length}</span>
        </td>
      </tr>
      {tasks.map((task) => {
        const detail = taskDetailHref(projectId, task.id);
        return (
          <tr key={task.id} className="group/row">
            <td className="sticky left-0 z-10 border-b border-border/40 bg-background px-2 py-1.5 group-hover/row:bg-[var(--accent-hover)]">
              <Link
                href={detail}
                className="block max-w-[230px] truncate text-[13px] font-medium text-foreground/90 hover:text-foreground"
                title={task.display_name}
              >
                {task.display_name}
              </Link>
            </td>
            <MatrixCell rate={rateFor(task, null)} href={detail} />
            {models.map((m) => (
              <MatrixCell
                key={m}
                rate={rateFor(task, m)}
                href={hrefWithRunCohort(detail, { ...EMPTY_COHORT, model: m })}
                title={`${task.display_name} · ${m}`}
              />
            ))}
          </tr>
        );
      })}
    </>
  );
}

function MatrixCell({ rate, href, title }: { rate: number | null; href: string; title?: string }) {
  if (rate === null) {
    return (
      <td className="border-b border-l border-border/40 px-2 py-1.5 text-center">
        <Link href={href} className="block" title={title ?? "No runs — open run history"}>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground/30">—</span>
        </Link>
      </td>
    );
  }
  const pct = Math.round(rate * 100);
  return (
    <td className="border-b border-l border-border/40 px-1 py-1.5">
      <Link
        href={href}
        title={title}
        className={cn(
          "flex h-7 items-center justify-center border hover:border-foreground/50",
          cellTone(pct),
        )}
      >
        <span className={cn("font-mono text-[12px] font-medium tabular-nums", toneFor(pct))}>
          {pct}%
        </span>
      </Link>
    </td>
  );
}
