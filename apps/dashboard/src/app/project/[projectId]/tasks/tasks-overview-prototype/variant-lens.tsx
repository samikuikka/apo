"use client";

import { useState } from "react";
import { Box, Brain, FlaskConical, History, ShieldCheck } from "lucide-react";
import type { PrototypeTaskOverview } from "./data";
import { passRate, projectSummary } from "./data";
import { HistoryStrip, MetricCell, ScopeBar, TaskIdentity } from "./shared";

type Lens = "baseline" | "model" | "execution" | "definition";

export function LensVariant({ tasks }: { tasks: PrototypeTaskOverview[] }) {
  const [lens, setLens] = useState<Lens>("baseline");
  const summary = projectSummary(tasks);

  return (
    <div>
      <ScopeBar />
      <div className="grid min-h-[650px] grid-cols-[210px_minmax(0,1fr)]">
        <aside className="border-r border-border px-4 py-5">
          <div className="mb-3 px-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Analysis Lens</div>
          <LensButton icon={ShieldCheck} label="Baseline Health" detail="Published, current" active={lens === "baseline"} onClick={() => setLens("baseline")} />
          <LensButton icon={Brain} label="Model" detail="Opus versus Sonnet" active={lens === "model"} onClick={() => setLens("model")} />
          <LensButton icon={Box} label="Execution" detail="Source revisions" active={lens === "execution"} onClick={() => setLens("execution")} />
          <LensButton icon={History} label="Definitions" detail="Test history" active={lens === "definition"} onClick={() => setLens("definition")} />
          <div className="mt-6 border-t border-border px-2 pt-4">
            <div className="text-[10px] text-muted-foreground">Current Result</div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              <MiniCount value={summary.passing} label="Good" tone="success" />
              <MiniCount value={summary.failing} label="Bad" tone="destructive" />
              <MiniCount value={summary.errors} label="Error" tone="warning" />
            </div>
          </div>
        </aside>

        <section className="px-6 py-5">
          <div className="mb-5"><div className="text-xs text-muted-foreground">{lensEyebrow(lens)}</div><h2 className="mt-1 text-[18px] font-semibold tracking-tight">{lensTitle(lens)}</h2></div>
          {lens === "baseline" && <BaselineLens tasks={tasks} />}
          {lens === "model" && <PairLens tasks={tasks} first="Opus 4 · high" second="Sonnet 4 · medium" getFirst={(task) => task.models.opus} getSecond={(task) => task.models.sonnet} />}
          {lens === "execution" && <PairLens tasks={tasks} first="b772ef1" second="a3d91c4" getFirst={(task) => task.executions.current} getSecond={(task) => task.executions.previous} />}
          {lens === "definition" && <DefinitionLens tasks={tasks} />}
        </section>
      </div>
    </div>
  );
}

function BaselineLens({ tasks }: { tasks: PrototypeTaskOverview[] }) {
  return <div className="divide-y divide-border border-y border-border">{tasks.map((task) => <div key={task.id} className="grid grid-cols-[1fr_120px_100px] items-center gap-4 py-3"><TaskIdentity task={task} /><MetricCell metrics={task.baseline} /><div className="text-right font-mono text-xs text-muted-foreground">${task.baseline.cost.toFixed(2)}</div></div>)}</div>;
}

function PairLens({ tasks, first, second, getFirst, getSecond }: { tasks: PrototypeTaskOverview[]; first: string; second: string; getFirst: (task: PrototypeTaskOverview) => PrototypeTaskOverview["baseline"]; getSecond: (task: PrototypeTaskOverview) => PrototypeTaskOverview["baseline"] }) {
  return <div><div className="grid grid-cols-[1fr_130px_130px_80px] gap-4 border-b border-border pb-2 text-[10px] uppercase tracking-wide text-muted-foreground"><span>Task</span><span>{first}</span><span>{second}</span><span>Delta</span></div>{tasks.map((task) => { const a = getFirst(task); const b = getSecond(task); const delta = (passRate(a) ?? 0) - (passRate(b) ?? 0); return <div key={task.id} className="grid grid-cols-[1fr_130px_130px_80px] items-center gap-4 border-b border-border/70 py-3"><TaskIdentity task={task} /><MetricCell metrics={a} compact /><MetricCell metrics={b} compact /><span className={`font-mono text-xs ${delta > 0 ? "text-success" : delta < 0 ? "text-destructive" : "text-muted-foreground"}`}>{delta > 0 ? "+" : ""}{delta} pts</span></div>; })}</div>;
}

function DefinitionLens({ tasks }: { tasks: PrototypeTaskOverview[] }) {
  return <div className="divide-y divide-border border-y border-border">{tasks.map((task) => <div key={task.id} className="grid grid-cols-[220px_1fr_100px] items-center gap-4 py-3"><TaskIdentity task={task} /><HistoryStrip history={task.history} /><span className="text-right text-[10px] text-warning">v3 → v4</span></div>)}</div>;
}

function LensButton({ icon: Icon, label, detail, active, onClick }: { icon: typeof FlaskConical; label: string; detail: string; active: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`mb-1 flex w-full items-start gap-2 border-l-2 px-2 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "border-foreground bg-card text-foreground" : "border-transparent text-muted-foreground hover:bg-card/50"}`}><Icon className="mt-0.5 h-3.5 w-3.5" /><span><span className="block text-xs font-semibold">{label}</span><span className="mt-0.5 block text-[10px] text-muted-foreground">{detail}</span></span></button>;
}

function MiniCount({ value, label, tone }: { value: number; label: string; tone: "success" | "destructive" | "warning" }) {
  const className = tone === "success" ? "text-success" : tone === "destructive" ? "text-destructive" : "text-warning";
  return <div><div className={`font-mono text-sm font-semibold ${className}`}>{value}</div><div className="text-[9px] text-muted-foreground">{label}</div></div>;
}

function lensEyebrow(lens: Lens) {
  if (lens === "baseline") return "One trusted Project state";
  if (lens === "model") return "Hold definitions and execution constant";
  if (lens === "execution") return "Hold definitions and model constant";
  return "See where evaluation semantics changed";
}

function lensTitle(lens: Lens) {
  if (lens === "baseline") return "Current Baseline Health";
  if (lens === "model") return "Model Performance";
  if (lens === "execution") return "Execution Revision Performance";
  return "Task Definition History";
}
