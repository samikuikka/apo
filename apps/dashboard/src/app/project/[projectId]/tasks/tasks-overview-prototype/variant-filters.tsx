"use client";

import { useMemo, useState } from "react";
import type { PrototypeRunV2, PrototypeTaskV2 } from "./data-v2";
import { shortSha } from "./data-v2";
import { EmptyBaseline, EvidenceLine, FilterGroup, RunStrip, TaskIdentityV2, WarningChip, type FilterOption } from "./shared";

/**
 * The "filters" variant — the normal Tasks page with dimension filters at the
 * top instead of an invented baseline.
 *
 * Every dimension apo actually stores becomes a filter: model+effort, task
 * definition revision, source commit, trigger kind. The page opens
 * unfiltered (the honest total) and the user narrows. There is no separate
 * "cohort mode" or "schedule mode" — schedule-anchored is just
 * `trigger = schedule`; cohort is just `def = current + source = current`.
 *
 * The "what is trustworthy" question becomes explicit: it's whatever filter
 * you have applied. No magic.
 */
export function FiltersVariant({ tasks }: { tasks: PrototypeTaskV2[] }) {
  const [model, setModel] = useState("all");
  const [defRev, setDefRev] = useState("all");
  const [source, setSource] = useState("all");
  const [trigger, setTrigger] = useState("all");

  // Build filter options from the data so new revisions/models appear
  // automatically. The "all" option is always first and labelled with the
  // total matching runs.
  const allRuns = useMemo(() => tasks.flatMap((t) => t.runs), [tasks]);

  const modelOptions = useMemo(() => buildConfigOptions(allRuns), [allRuns]);
  const defRevOptions = useMemo(() => buildShaOptions(allRuns, (r) => r.taskRevision.commitSha), [allRuns]);
  const sourceOptions = useMemo(() => buildShaOptions(allRuns, (r) => r.sourceCommitSha), [allRuns]);
  const triggerOptions = useMemo(() => buildSimpleOptions(allRuns, (r) => r.trigger), [allRuns]);

  const predicate = useMemo(
    () => (r: PrototypeRunV2) =>
      (model === "all" || configKey(r.config) === model) &&
      (defRev === "all" || r.taskRevision.commitSha === defRev) &&
      (source === "all" || r.sourceCommitSha === source) &&
      (trigger === "all" || r.trigger === trigger),
    [model, defRev, source, trigger],
  );

  const rows = useMemo(
    () =>
      tasks.map((task) => {
        const matching = task.runs.filter(predicate);
        return { task, matching, baseline: aggregateLocal(matching) };
      }),
    [tasks, predicate],
  );

  const totals = useMemo(() => {
    const matching = allRuns.filter(predicate);
    return { matching: matching.length, total: allRuns.length };
  }, [allRuns, predicate]);

  const summary = useMemo(() => summarise(rows), [rows]);

  const anyFilter = model !== "all" || defRev !== "all" || source !== "all" || trigger !== "all";

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4 px-6 pb-3 pt-5">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">Tasks</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Filter by any dimension apo records. The numbers below reflect only matching runs.
          </p>
        </div>
        <div className="flex items-center gap-5 text-xs">
          <SummaryCount value={summary.healthy} label="Healthy" tone="success" />
          <SummaryCount value={summary.needsAttention} label="Needs attention" tone="destructive" />
          <SummaryCount value={summary.empty} label="No matching runs" tone="warning" />
        </div>
      </div>

      <FilterBar>
        <FilterGroup label="Model" options={modelOptions} value={model} onChange={setModel} />
        <FilterGroup label="Definition" options={defRevOptions} value={defRev} onChange={setDefRev} />
        <FilterGroup label="Source" options={sourceOptions} value={source} onChange={setSource} />
        <FilterGroup label="Trigger" options={triggerOptions} value={trigger} onChange={setTrigger} />
        <div className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>
            <span className="font-mono text-foreground/80">{totals.matching}</span> of{" "}
            <span className="font-mono">{totals.total}</span> runs
          </span>
          {anyFilter && (
            <button
              type="button"
              onClick={() => {
                setModel("all");
                setDefRev("all");
                setSource("all");
                setTrigger("all");
              }}
              className="border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      </FilterBar>

      <div className="px-6 py-5">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="pb-2 font-normal">Task</th>
              <th className="pb-2 font-normal">Pass rate</th>
              <th className="pb-2 font-normal">Sample</th>
              <th className="pb-2 font-normal">Errors</th>
              <th className="pb-2 font-normal">Cost</th>
              <th className="pb-2 font-normal">Matching vs all history</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ task, matching, baseline }) => {
              const latest = matching[matching.length - 1];
              const isEmpty = matching.length === 0;
              return (
                <tr key={task.id} className={`border-b border-border/70 align-top ${isEmpty ? "bg-card/20" : ""}`}>
                  <td className="py-3 pr-5">
                    <TaskIdentityV2 name={task.name} folder={task.folder} tag={task.tag} />
                    {task.schedule && (
                      <div className="mt-1.5 text-[10px] text-muted-foreground">
                        <span className="border border-border/70 px-1 text-foreground/70">{task.schedule.cadence}</span>{" "}
                        <span className="font-mono">{task.schedule.name}</span>
                      </div>
                    )}
                  </td>
                  <td className="py-3 pr-5">
                    {isEmpty ? (
                      <EmptyBaseline reason={anyFilter ? "No runs match the current filters." : "Never run."} />
                    ) : (
                      <BaselineNumber baseline={baseline} />
                    )}
                  </td>
                  <td className="py-3 pr-5">
                    {isEmpty ? (
                      <span className="text-[10px] text-muted-foreground/60">—</span>
                    ) : (
                      <div>
                        <div className="font-mono text-xs tabular-nums text-muted-foreground">{matching.length} runs</div>
                        {matching.length === 1 && <div className="text-[10px] text-warning">low confidence</div>}
                        {latest && <EvidenceLine run={latest} showTrigger={trigger === "all"} />}
                      </div>
                    )}
                  </td>
                  <td className="py-3 pr-5 font-mono text-xs tabular-nums">{isEmpty || baseline.errors === 0 ? "—" : baseline.errors}</td>
                  <td className="py-3 pr-5 font-mono text-xs tabular-nums">{isEmpty ? "—" : `$${baseline.cost.toFixed(2)}`}</td>
                  <td className="py-3 pr-5">
                    <RunStrip runs={task.runs} counted={(r) => predicate(r)} />
                    {task.runs.length > 0 && (
                      <div className="mt-1.5 text-[10px] text-muted-foreground">
                        {matching.length} of {task.runs.length} runs shown
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="mt-5 rounded-sm border border-border/60 bg-card/20 px-4 py-3 text-[11px] text-muted-foreground">
          <strong className="text-foreground/80">Reading this view:</strong> there is no special "baseline" concept.
          The page opens unfiltered — what you see first is every run apo has recorded. Narrow with the filters above
          to answer specific questions:{" "}
          <code className="font-mono text-foreground/70">trigger = schedule</code> recovers a schedule-anchored view;{" "}
          <code className="font-mono text-foreground/70">definition = b772ef1 + source = b772ef1</code> recovers a
          published-cohort view. Empty rows after filtering are honest "no evidence" rather than hidden.
        </div>

        {anyFilter && (
          <div className="mt-3">
            <WarningChip tone="info">
              Filters active · {totals.matching} of {totals.total} runs
            </WarningChip>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout + small helpers
// ---------------------------------------------------------------------------

function FilterBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-y border-border bg-card/30 px-6 py-3 text-xs">
      {children}
    </div>
  );
}

interface LocalBaseline {
  runs: PrototypeRunV2[];
  passedChecks: number;
  totalChecks: number;
  errors: number;
  cost: number;
  checkRate: number;
  passRate: number | null;
}

function aggregateLocal(runs: PrototypeRunV2[]): LocalBaseline {
  const passedChecks = runs.reduce((s, r) => s + r.passedChecks, 0);
  const totalChecks = runs.reduce((s, r) => s + r.totalChecks, 0);
  const errors = runs.filter((r) => r.status === "error").length;
  const cost = runs.reduce((s, r) => s + r.cost, 0);
  const checkRate = totalChecks === 0 ? 0 : Math.round((passedChecks / totalChecks) * 100);
  const passRate = runs.length === 0 ? null : Math.round((runs.filter((r) => r.status === "passed").length / runs.length) * 100);
  return { runs, passedChecks, totalChecks, errors, cost, checkRate, passRate };
}

function BaselineNumber({ baseline }: { baseline: LocalBaseline }) {
  const rate = baseline.passRate;
  if (rate === null) {
    return (
      <div>
        <div className="text-xs text-warning">Execution error</div>
        <div className="mt-0.5 text-[10px] text-muted-foreground">No verdict</div>
      </div>
    );
  }
  const tone = rate >= 80 ? "text-success" : rate < 50 ? "text-destructive" : "text-warning";
  return (
    <div>
      <div className={`font-mono text-[18px] font-semibold tabular-nums ${tone}`}>{rate}%</div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">
        {baseline.passedChecks}/{baseline.totalChecks} checks · {baseline.checkRate}% pass
      </div>
    </div>
  );
}

function SummaryCount({ value, label, tone }: { value: number; label: string; tone: "success" | "destructive" | "warning" }) {
  const cls = tone === "success" ? "text-success" : tone === "destructive" ? "text-destructive" : "text-warning";
  return (
    <span>
      <span className={`mr-1.5 font-mono font-semibold ${cls}`}>{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function summarise(rows: Array<{ baseline: LocalBaseline }>) {
  let healthy = 0;
  let needsAttention = 0;
  let empty = 0;
  for (const { baseline } of rows) {
    if (baseline.runs.length === 0) {
      empty += 1;
      continue;
    }
    const rate = baseline.passRate ?? 0;
    if (baseline.errors > 0 || rate < 80) needsAttention += 1;
    else healthy += 1;
  }
  return { healthy, needsAttention, empty };
}

// ---------------------------------------------------------------------------
// Filter option builders — derive options from the data, count matches.
// ---------------------------------------------------------------------------

function configKey(c: { model: string; effort: string }): string {
  return `${c.model}:${c.effort}`;
}

function describeConfigKey(key: string): string {
  const [model, effort] = key.split(":");
  const modelLabel = model === "opus" ? "Opus 4" : model === "sonnet" ? "Sonnet 4" : model;
  return `${modelLabel} · ${effort}`;
}

function buildConfigOptions(runs: PrototypeRunV2[]): FilterOption[] {
  const counts = new Map<string, number>();
  for (const r of runs) {
    const key = configKey(r.config);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const options: FilterOption[] = sorted.map(([value, n]) => ({ value, label: describeConfigKey(value), count: n }));
  options.unshift({ value: "all", label: "All models", count: runs.length });
  return options;
}

function buildShaOptions(runs: PrototypeRunV2[], select: (r: PrototypeRunV2) => string): FilterOption[] {
  const counts = new Map<string, number>();
  for (const r of runs) {
    const sha = select(r);
    counts.set(sha, (counts.get(sha) ?? 0) + 1);
  }
  // Most recent first: stable enough for a prototype (relies on runs being chronological).
  const ordered = [...counts.entries()];
  const options: FilterOption[] = ordered.map(([value, n]) => ({ value, label: shortSha(value), count: n }));
  options.unshift({ value: "all", label: "All", count: runs.length });
  return options;
}

function buildSimpleOptions<T extends string>(runs: PrototypeRunV2[], select: (r: PrototypeRunV2) => T): FilterOption[] {
  const counts = new Map<T, number>();
  for (const r of runs) {
    const key = select(r);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const options: FilterOption[] = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, n]) => ({ value, label: value, count: n }));
  options.unshift({ value: "all", label: "All", count: runs.length });
  return options;
}
