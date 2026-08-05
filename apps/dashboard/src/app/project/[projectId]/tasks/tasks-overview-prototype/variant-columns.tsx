"use client";

import { useMemo, useState } from "react";
import type { PrototypeRunV2, PrototypeTaskV2 } from "./data-v2";
import { shortSha } from "./data-v2";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ColumnFilterHeader, EmptyBaseline, EvidenceLine, PlainHeader, RunStrip, TaskIdentityV2, WarningChip, type ColumnFilterOption } from "./shared";

/**
 * Column-style filters, matching the traces-page table aesthetic.
 *
 * Each dimension (model, definition revision, source commit, trigger) is a
 * column header with an autoFilter dropdown. Default = all values selected
 * (the honest total). Unchecking values narrows the runs that aggregate
 * into each Task row's metrics.
 *
 * Unlike `filters` (a separate horizontal bar of chips), this variant lives
 * inside the table chrome itself, so the page reads as one data grid.
 */
export function ColumnsVariant({ tasks }: { tasks: PrototypeTaskV2[] }) {
  const allRuns = useMemo(() => tasks.flatMap((t) => t.runs), [tasks]);

  const modelOptions = useMemo(() => buildConfigOptions(allRuns), [allRuns]);
  const defOptions = useMemo(() => buildShaOptions(allRuns, (r) => r.taskRevision.commitSha), [allRuns]);
  const sourceOptions = useMemo(() => buildShaOptions(allRuns, (r) => r.sourceCommitSha), [allRuns]);
  const triggerOptions = useMemo(() => buildSimpleOptions(allRuns, (r) => r.trigger), [allRuns]);

  // Default = all values selected, so the first paint is the unfiltered total.
  const allOf = (opts: ColumnFilterOption[]) => new Set(opts.map((o) => o.value));
  const [modelSel, setModelSel] = useState<Set<string>>(() => allOf(modelOptions));
  const [defSel, setDefSel] = useState<Set<string>>(() => allOf(defOptions));
  const [sourceSel, setSourceSel] = useState<Set<string>>(() => allOf(sourceOptions));
  const [triggerSel, setTriggerSel] = useState<Set<string>>(() => allOf(triggerOptions));

  const predicate = useMemo(
    () => (r: PrototypeRunV2) =>
      modelSel.has(configKey(r.config)) &&
      defSel.has(r.taskRevision.commitSha) &&
      sourceSel.has(r.sourceCommitSha) &&
      triggerSel.has(r.trigger),
    [modelSel, defSel, sourceSel, triggerSel],
  );

  const rows = useMemo(
    () =>
      tasks.map((task) => {
        const matching = task.runs.filter(predicate);
        return { task, matching, baseline: aggregate(matching) };
      }),
    [tasks, predicate],
  );

  const totals = useMemo(() => {
    const matching = allRuns.filter(predicate).length;
    return { matching, total: allRuns.length };
  }, [allRuns, predicate]);

  const summary = useMemo(() => summarise(rows), [rows]);

  const anyFilter =
    modelSel.size < modelOptions.length ||
    defSel.size < defOptions.length ||
    sourceSel.size < sourceOptions.length ||
    triggerSel.size < triggerOptions.length;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4 px-6 pb-3 pt-5">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">Tasks</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Click any column header to filter. Numbers below reflect only runs matching every active filter.
          </p>
        </div>
        <div className="flex items-center gap-5 text-xs">
          <SummaryCount value={summary.healthy} label="Healthy" tone="success" />
          <SummaryCount value={summary.needsAttention} label="Needs attention" tone="destructive" />
          <SummaryCount value={summary.empty} label="No matching runs" tone="warning" />
        </div>
      </div>

      <div className="px-6 py-3">
        <Table density="compact">
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="w-[260px] whitespace-nowrap border-b">
                <PlainHeader label="Task" />
              </TableHead>
              <TableHead className="whitespace-nowrap border-b">
                <ColumnFilterHeader label="Model" options={modelOptions} selected={modelSel} onChange={setModelSel} />
              </TableHead>
              <TableHead className="whitespace-nowrap border-b">
                <ColumnFilterHeader label="Definition" options={defOptions} selected={defSel} onChange={setDefSel} />
              </TableHead>
              <TableHead className="whitespace-nowrap border-b">
                <ColumnFilterHeader label="Source" options={sourceOptions} selected={sourceSel} onChange={setSourceSel} />
              </TableHead>
              <TableHead className="whitespace-nowrap border-b">
                <ColumnFilterHeader label="Trigger" options={triggerOptions} selected={triggerSel} onChange={setTriggerSel} />
              </TableHead>
              <TableHead className="whitespace-nowrap border-b">
                <PlainHeader label="Pass rate" />
              </TableHead>
              <TableHead className="whitespace-nowrap border-b">
                <PlainHeader label="Sample" />
              </TableHead>
              <TableHead className="whitespace-nowrap border-b">
                <PlainHeader label="Cost" align="right" />
              </TableHead>
              <TableHead className="whitespace-nowrap border-b">
                <PlainHeader label="History" />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ task, matching, baseline }) => {
              const latest = matching[matching.length - 1];
              const isEmpty = matching.length === 0;
              return (
                <TableRow key={task.id} className={isEmpty ? "bg-card/20" : ""}>
                  <TableCell className="align-top">
                    <TaskIdentityV2 name={task.name} folder={task.folder} tag={task.tag} />
                    {task.schedule && (
                      <div className="mt-1.5 text-[10px] text-muted-foreground">
                        <span className="border border-border/70 px-1 text-foreground/70">{task.schedule.cadence}</span>{" "}
                        <span className="font-mono">{task.schedule.name}</span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <DimensionSummary values={distinctConfigs(matching)} format={describeConfigKey} />
                  </TableCell>
                  <TableCell className="align-top">
                    <DimensionSummary values={distinct(matching, (r) => r.taskRevision.commitSha)} format={shortSha} />
                  </TableCell>
                  <TableCell className="align-top">
                    <DimensionSummary values={distinct(matching, (r) => r.sourceCommitSha)} format={shortSha} />
                  </TableCell>
                  <TableCell className="align-top">
                    <DimensionSummary values={distinct(matching, (r) => r.trigger)} format={(s) => s} />
                  </TableCell>
                  <TableCell className="align-top">
                    {isEmpty ? <EmptyBaseline reason={anyFilter ? "No runs match." : "Never run."} /> : <RateCell baseline={baseline} />}
                  </TableCell>
                  <TableCell className="align-top">
                    {isEmpty ? (
                      <span className="text-[10px] text-muted-foreground/60">—</span>
                    ) : (
                      <div>
                        <div className="font-mono text-xs tabular-nums text-muted-foreground">{matching.length}</div>
                        {matching.length === 1 && <div className="text-[10px] text-warning">low conf.</div>}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="align-top text-right font-mono text-xs tabular-nums">
                    {isEmpty ? "—" : `$${baseline.cost.toFixed(2)}`}
                  </TableCell>
                  <TableCell className="align-top">
                    <RunStrip runs={task.runs} counted={(r) => predicate(r)} />
                    {latest && <EvidenceLine run={latest} showTrigger={triggerSel.size >= triggerOptions.length} />}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        <div className="mt-4 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>
            <span className="font-mono text-foreground/80">{totals.matching}</span> of{" "}
            <span className="font-mono">{totals.total}</span> runs shown
          </span>
          {anyFilter && (
            <button
              type="button"
              onClick={() => {
                setModelSel(allOf(modelOptions));
                setDefSel(allOf(defOptions));
                setSourceSel(allOf(sourceOptions));
                setTriggerSel(allOf(triggerOptions));
              }}
              className="border border-border px-2 py-1 text-[11px] hover:text-foreground"
            >
              Reset all filters
            </button>
          )}
        </div>

        {anyFilter && (
          <div className="mt-3">
            <WarningChip tone="info">Filters active · {totals.matching} of {totals.total} runs</WarningChip>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cells + helpers
// ---------------------------------------------------------------------------

function DimensionSummary({ values, format }: { values: string[]; format: (v: string) => string }) {
  if (values.length === 0) return <span className="text-[10px] text-muted-foreground/60">—</span>;
  if (values.length === 1) return <span className="block text-xs text-muted-foreground">{format(values[0])}</span>;
  return (
    <span className="block text-xs text-muted-foreground">
      {values.length} values
      <span className="ml-1 text-[10px] text-warning">mixed</span>
    </span>
  );
}

function RateCell({ baseline }: { baseline: ReturnType<typeof aggregate> }) {
  const rate = baseline.passRate;
  if (rate === null) return <span className="text-xs text-warning">error</span>;
  const tone = rate >= 80 ? "text-success" : rate < 50 ? "text-destructive" : "text-warning";
  return (
    <div>
      <div className={`font-mono text-[14px] font-semibold tabular-nums ${tone}`}>{rate}%</div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">
        {baseline.passedChecks}/{baseline.totalChecks} · {baseline.checkRate}%
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

interface LocalBaseline {
  runs: PrototypeRunV2[];
  passedChecks: number;
  totalChecks: number;
  errors: number;
  cost: number;
  checkRate: number;
  passRate: number | null;
}

function aggregate(runs: PrototypeRunV2[]): LocalBaseline {
  const passedChecks = runs.reduce((s, r) => s + r.passedChecks, 0);
  const totalChecks = runs.reduce((s, r) => s + r.totalChecks, 0);
  const errors = runs.filter((r) => r.status === "error").length;
  const cost = runs.reduce((s, r) => s + r.cost, 0);
  const checkRate = totalChecks === 0 ? 0 : Math.round((passedChecks / totalChecks) * 100);
  const passRate = runs.length === 0 ? null : Math.round((runs.filter((r) => r.status === "passed").length / runs.length) * 100);
  return { runs, passedChecks, totalChecks, errors, cost, checkRate, passRate };
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

function distinct<T>(runs: PrototypeRunV2[], select: (r: PrototypeRunV2) => T): T[] {
  const seen = new Set<T>();
  for (const r of runs) seen.add(select(r));
  return [...seen];
}

function distinctConfigs(runs: PrototypeRunV2[]): string[] {
  return distinct(runs, (r) => configKey(r.config));
}

function configKey(c: { model: string; effort: string }): string {
  return `${c.model}:${c.effort}`;
}

function describeConfigKey(key: string): string {
  const [model, effort] = key.split(":");
  const modelLabel = model === "opus" ? "Opus 4" : model === "sonnet" ? "Sonnet 4" : model;
  return `${modelLabel} · ${effort}`;
}

function buildConfigOptions(runs: PrototypeRunV2[]): ColumnFilterOption[] {
  const counts = new Map<string, number>();
  for (const r of runs) {
    const key = configKey(r.config);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, label: describeConfigKey(value), count }));
}

function buildShaOptions(runs: PrototypeRunV2[], select: (r: PrototypeRunV2) => string): ColumnFilterOption[] {
  const counts = new Map<string, number>();
  for (const r of runs) {
    const sha = select(r);
    counts.set(sha, (counts.get(sha) ?? 0) + 1);
  }
  return [...counts.entries()].map(([value, count]) => ({ value, label: shortSha(value), count }));
}

function buildSimpleOptions(runs: PrototypeRunV2[], select: (r: PrototypeRunV2) => string): ColumnFilterOption[] {
  const counts = new Map<string, number>();
  for (const r of runs) {
    const key = select(r);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, label: value, count }));
}
