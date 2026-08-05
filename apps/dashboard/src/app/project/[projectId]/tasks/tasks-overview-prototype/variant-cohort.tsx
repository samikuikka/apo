"use client";

import { useMemo, useState } from "react";
import type { PrototypeTaskV2, PrototypeProjectScope, RunConfig } from "./data-v2";
import { cohortBaseline, describeConfig, shortSha } from "./data-v2";
import {
  EmptyBaseline,
  EvidenceLine,
  ModelPicker,
  RunStrip,
  SampleSize,
  TaskIdentityV2,
  WarningChip,
  type ModelOption,
} from "./shared";

/**
 * Model B — Published-cohort baseline.
 *
 * Current = runs whose (task definition revision, source commit) match the
 * Project's published ones, further filtered by a model the user picks.
 * Tasks with no matching runs show an empty baseline row.
 */
export function CohortVariant({ tasks, scope }: { tasks: PrototypeTaskV2[]; scope: PrototypeProjectScope }) {
  // Default selection = the most common config across the cohort, so the page
  // opens on a sensible single-model view. "All models" is a deliberate second
  // click, not the default — that's where mixed cohorts become visible.
  const defaultConfig = useMemo(() => pickDefaultConfig(tasks, scope), [tasks, scope]);
  const [configFilter, setConfigFilter] = useState<RunConfig | null>(defaultConfig);

  const options = useMemo<ModelOption[]>(() => buildOptions(tasks, scope), [tasks, scope]);

  const rows = useMemo(
    () => tasks.map((t) => ({ task: t, baseline: cohortBaseline(t, scope, configFilter) })),
    [tasks, scope, configFilter],
  );

  const summary = useMemo(() => summarise(rows.map((r) => r.baseline)), [rows]);

  const isMixedProject = scope.availableConfigs.length > 1;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4 px-6 pb-4 pt-5">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">Current health, published-cohort baseline</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Runs against the current published definitions and source revision. Other runs appear in Trends only.
          </p>
        </div>
        <div className="flex items-center gap-5 text-xs">
          <SummaryCount value={summary.healthy} label="Healthy" tone="success" />
          <SummaryCount value={summary.needsAttention} label="Needs attention" tone="destructive" />
          <SummaryCount value={summary.empty} label="No baseline" tone="warning" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-y border-border bg-card/30 px-6 py-3 text-xs">
        <span className="font-semibold">Published scope</span>
        <Scope label="Definitions" value={`${shortSha(scope.publishedTaskRevision.commitSha)} · ${shortSha(scope.publishedTaskRevision.contentSha, 7)}`} mono />
        <Scope label="Source" value={shortSha(scope.publishedSourceCommit)} mono />
        <div className="ml-2">
          <ModelPicker options={options} value={configFilter} onChange={setConfigFilter} />
        </div>
        {isMixedProject && (
          <span className="ml-auto">
            <WarningChip tone="warning">Mixed-model Project · {scope.availableConfigs.length} configs observed</WarningChip>
          </span>
        )}
      </div>

      <div className="px-6 py-5">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="pb-2 font-normal">Task</th>
              <th className="pb-2 font-normal">Baseline</th>
              <th className="pb-2 font-normal">Sample</th>
              <th className="pb-2 font-normal">Errors</th>
              <th className="pb-2 font-normal">Cost</th>
              <th className="pb-2 font-normal">Cohort vs history</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ task, baseline }) => {
              const latestInCohort = baseline.runs[baseline.runs.length - 1];
              const isEmpty = baseline.runs.length === 0;
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
                      <EmptyBaseline reason={emptyReason(task, configFilter)} />
                    ) : (
                      <BaselineNumber baseline={baseline} />
                    )}
                  </td>
                  <td className="py-3 pr-5">
                    <div className="font-mono text-xs tabular-nums text-muted-foreground">
                      {isEmpty ? "—" : <SampleSize n={baseline.runs.length} />}
                    </div>
                    {latestInCohort && <EvidenceLine run={latestInCohort} showTrigger={false} />}
                  </td>
                  <td className="py-3 pr-5 font-mono text-xs tabular-nums">{isEmpty || baseline.errors === 0 ? "—" : baseline.errors}</td>
                  <td className="py-3 pr-5 font-mono text-xs tabular-nums">{isEmpty ? "—" : `$${baseline.cost.toFixed(2)}`}</td>
                  <td className="py-3 pr-5">
                    <RunStrip
                      runs={task.runs}
                      counted={(r) =>
                        r.taskRevision.contentSha === scope.publishedTaskRevision.contentSha &&
                        r.sourceCommitSha === scope.publishedSourceCommit &&
                        (configFilter === null || sameConfigNullable(r.config, configFilter))
                      }
                    />
                    {task.runs.length > 0 && (
                      <div className="mt-1.5 text-[10px] text-muted-foreground">
                        {baseline.runs.length} of {task.runs.length} runs counted
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="mt-5 rounded-sm border border-border/60 bg-card/20 px-4 py-3 text-[11px] text-muted-foreground">
          <strong className="text-foreground/80">Reading this view:</strong> each row's number reflects only runs that
          match the published scope {configFilter ? <>and the <span className="font-mono">{describeConfig(configFilter)}</span> model</> : "across every model"}.
          Dimmed squares in the right strip are runs that exist but were excluded — older revisions, source drift, or
          other models. Switch the model picker to see how the baseline shifts.
        </div>
      </div>
    </div>
  );
}

function BaselineNumber({ baseline }: { baseline: ReturnType<typeof cohortBaseline> }) {
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

function emptyReason(task: PrototypeTaskV2, filter: RunConfig | null): string {
  if (task.runs.length === 0) return "Never run.";
  const hasOtherModel = task.runs.some((r) => filter !== null && !sameConfigNullable(r.config, filter));
  const hasOldRevision = task.runs.every((r) => r.sourceCommitSha !== task.runs[task.runs.length - 1].sourceCommitSha);
  if (hasOtherModel) return `No runs on this model. Try switching the picker.`;
  if (hasOldRevision) return `Runs exist on older revisions only.`;
  return `No runs match the published cohort yet.`;
}

function Scope({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="text-muted-foreground">
      <span className="mr-1 text-muted-foreground/60">{label}</span>
      <span className={`${mono ? "font-mono" : ""} text-foreground`}>{value}</span>
    </span>
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

interface RowSummary {
  healthy: number;
  needsAttention: number;
  empty: number;
}

function summarise(baselines: ReturnType<typeof cohortBaseline>[]): RowSummary {
  let healthy = 0;
  let needsAttention = 0;
  let empty = 0;
  for (const b of baselines) {
    if (b.runs.length === 0) {
      empty += 1;
      continue;
    }
    const rate = b.passRate ?? 0;
    if (b.errors > 0 || rate < 80) needsAttention += 1;
    else healthy += 1;
  }
  return { healthy, needsAttention, empty };
}

function pickDefaultConfig(tasks: PrototypeTaskV2[], scope: PrototypeProjectScope): RunConfig | null {
  // Most common config among runs that match the published cohort.
  const counts = new Map<string, { config: RunConfig; n: number }>();
  for (const task of tasks) {
    for (const r of task.runs) {
      if (
        r.taskRevision.contentSha !== scope.publishedTaskRevision.contentSha ||
        r.sourceCommitSha !== scope.publishedSourceCommit
      ) continue;
      const key = `${r.config.model}:${r.config.effort}`;
      const existing = counts.get(key);
      if (existing) existing.n += 1;
      else counts.set(key, { config: r.config, n: 1 });
    }
  }
  if (counts.size === 0) return null;
  const sorted = [...counts.values()].sort((a, b) => b.n - a.n);
  return sorted[0].config;
}

function buildOptions(tasks: PrototypeTaskV2[], scope: PrototypeProjectScope): ModelOption[] {
  const counts = new Map<string, { config: RunConfig; n: number }>();
  let allCount = 0;
  for (const task of tasks) {
    for (const r of task.runs) {
      if (
        r.taskRevision.contentSha !== scope.publishedTaskRevision.contentSha ||
        r.sourceCommitSha !== scope.publishedSourceCommit
      ) continue;
      allCount += 1;
      const key = `${r.config.model}:${r.config.effort}`;
      const existing = counts.get(key);
      if (existing) existing.n += 1;
      else counts.set(key, { config: r.config, n: 1 });
    }
  }
  const options: ModelOption[] = [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .map(({ config, n }) => ({ config, label: describeConfig(config), count: n }));
  options.unshift({ config: null, label: "All models", count: allCount });
  return options;
}

function sameConfigNullable(a: RunConfig, b: RunConfig | null): boolean {
  return b === null ? true : a.model === b.model && a.effort === b.effort;
}
