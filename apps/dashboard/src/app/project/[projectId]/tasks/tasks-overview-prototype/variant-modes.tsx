"use client";

import { useState } from "react";
import type { PrototypeTaskOverview } from "./data";
import { passRate, projectSummary } from "./data";
import { HistoryStrip, Legend, MetricCell, ScopeBar, TaskIdentity } from "./shared";

type PageMode = "overview" | "trends" | "breakdown";
type Breakdown = "model" | "execution";

export function ModeVariant({ tasks }: { tasks: PrototypeTaskOverview[] }) {
  const [mode, setMode] = useState<PageMode>("overview");
  const [breakdown, setBreakdown] = useState<Breakdown>("model");
  const summary = projectSummary(tasks);

  return (
    <div>
      <div className="flex items-end justify-between px-6 pb-4 pt-5">
        <div>
          <div className="flex gap-5">
            {(["overview", "trends", "breakdown"] as const).map((item) => (
              <button key={item} type="button" onClick={() => setMode(item)} className={`border-b-2 pb-2 text-[13px] font-semibold capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${mode === item ? "border-foreground text-foreground" : "border-transparent text-muted-foreground"}`}>
                {item}
              </button>
            ))}
          </div>
          <div className="mt-3 text-xs text-muted-foreground">{modeDescription(mode)}</div>
        </div>
        <div className="flex items-center gap-5 text-xs">
          <Count value={summary.passing} label="Healthy" tone="success" />
          <Count value={summary.failing} label="Needs attention" tone="destructive" />
          <Count value={summary.errors} label="Error" tone="warning" />
        </div>
      </div>

      <ScopeBar />

      {mode === "overview" && <OverviewTable tasks={tasks} />}
      {mode === "trends" && <TrendsTable tasks={tasks} />}
      {mode === "breakdown" && <BreakdownTable tasks={tasks} breakdown={breakdown} onBreakdown={setBreakdown} />}
    </div>
  );
}

function OverviewTable({ tasks }: { tasks: PrototypeTaskOverview[] }) {
  return (
    <div className="px-6 py-5">
      <table className="w-full border-collapse text-left">
        <thead><tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground"><th className="pb-2 font-normal">Task</th><th className="pb-2 font-normal">Baseline Health</th><th className="pb-2 font-normal">Execution Errors</th><th className="pb-2 font-normal">Average Cost</th><th className="pb-2 text-right font-normal">All-History Rate</th></tr></thead>
        <tbody>{tasks.map((task) => <tr key={task.id} className="border-b border-border/70"><td className="py-3 pr-5"><TaskIdentity task={task} /></td><td className="py-3"><MetricCell metrics={task.baseline} /></td><td className="py-3 font-mono text-xs tabular-nums">{task.baseline.errors || "—"}</td><td className="py-3 font-mono text-xs tabular-nums">${task.baseline.cost.toFixed(2)}</td><td className="py-3 text-right"><span className="font-mono text-xs text-muted-foreground line-through decoration-muted-foreground/50">{task.allHistoryRate}%</span><span className="ml-2 text-[10px] text-muted-foreground">legacy</span></td></tr>)}</tbody>
      </table>
    </div>
  );
}

function TrendsTable({ tasks }: { tasks: PrototypeTaskOverview[] }) {
  return (
    <div className="px-6 py-5">
      <div className="mb-4 flex items-center justify-between"><Legend /><span className="text-[10px] text-muted-foreground">Oldest → newest</span></div>
      <div className="border-y border-border">
        {tasks.map((task) => <div key={task.id} className="grid grid-cols-[260px_minmax(300px,1fr)_100px] items-center gap-4 border-b border-border/70 px-3 py-3 last:border-0"><TaskIdentity task={task} /><HistoryStrip history={task.history} /><div className="text-right"><MetricCell metrics={task.baseline} compact /></div></div>)}
      </div>
    </div>
  );
}

function BreakdownTable({ tasks, breakdown, onBreakdown }: { tasks: PrototypeTaskOverview[]; breakdown: Breakdown; onBreakdown: (value: Breakdown) => void }) {
  const columns = breakdown === "model"
    ? [{ key: "first", label: "Opus 4 · high" }, { key: "second", label: "Sonnet 4 · medium" }]
    : [{ key: "first", label: "b772ef1 · current" }, { key: "second", label: "a3d91c4 · previous" }];
  return (
    <div className="px-6 py-5">
      <div className="mb-4 flex items-center gap-2 text-xs"><span className="text-muted-foreground">Break Down By</span>{(["model", "execution"] as const).map((item) => <button key={item} type="button" onClick={() => onBreakdown(item)} className={`border px-2.5 py-1.5 capitalize ${breakdown === item ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground"}`}>{item}</button>)}</div>
      <table className="w-full border-collapse border border-border text-left">
        <thead><tr className="bg-card text-xs"><th className="border-b border-border px-4 py-3">Task</th>{columns.map((column) => <th key={column.key} className="border-b border-l border-border px-4 py-3">{column.label}</th>)}<th className="border-b border-l border-border px-4 py-3">Delta</th></tr></thead>
        <tbody>{tasks.map((task) => {
          const first = breakdown === "model" ? task.models.opus : task.executions.current;
          const second = breakdown === "model" ? task.models.sonnet : task.executions.previous;
          const delta = (passRate(first) ?? 0) - (passRate(second) ?? 0);
          return <tr key={task.id} className="border-b border-border/70"><td className="px-4 py-3"><TaskIdentity task={task} /></td><td className="border-l border-border px-4 py-3"><MetricCell metrics={first} /></td><td className="border-l border-border px-4 py-3"><MetricCell metrics={second} /></td><td className={`border-l border-border px-4 py-3 font-mono text-xs ${delta > 0 ? "text-success" : delta < 0 ? "text-destructive" : "text-muted-foreground"}`}>{delta > 0 ? "+" : ""}{delta} pts</td></tr>;
        })}</tbody>
      </table>
    </div>
  );
}

function Count({ value, label, tone }: { value: number; label: string; tone: "success" | "destructive" | "warning" }) {
  const toneClass = tone === "success" ? "text-success" : tone === "destructive" ? "text-destructive" : "text-warning";
  return <span><span className={`mr-1.5 font-mono font-semibold ${toneClass}`}>{value}</span><span className="text-muted-foreground">{label}</span></span>;
}

function modeDescription(mode: PageMode) {
  if (mode === "overview") return "Current Project health from one explicit baseline scope.";
  if (mode === "trends") return "Chronological evidence with definition, execution, and model boundaries.";
  return "Compare one dimension while holding the others constant.";
}
