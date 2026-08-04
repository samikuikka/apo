import type { PrototypeHistoryPoint, PrototypeMetrics, PrototypeTaskOverview } from "./data";
import { BASELINE_SCOPE, passRate } from "./data";

export function ScopeBar() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-y border-border bg-card/30 px-6 py-3 text-xs">
      <span className="font-semibold">Baseline</span>
      <Scope label="Definitions" value={BASELINE_SCOPE.definition} />
      <Scope label="Execution" value={BASELINE_SCOPE.execution} mono />
      <Scope label="Configuration" value={BASELINE_SCOPE.configuration} />
      <button type="button" className="ml-auto border border-border px-2.5 py-1.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Explore Another Scope
      </button>
    </div>
  );
}

export function TaskIdentity({ task }: { task: PrototypeTaskOverview }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[13px] font-semibold">{task.name}</div>
      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="font-mono">{task.folder}</span>
        <span className="border border-border px-1">{task.tag}</span>
      </div>
    </div>
  );
}

export function MetricCell({ metrics, compact = false }: { metrics: PrototypeMetrics; compact?: boolean }) {
  const rate = passRate(metrics);
  if (rate === null) {
    return <div className="text-xs text-warning">Execution error<span className="mt-0.5 block text-[10px] text-muted-foreground">No verdict</span></div>;
  }
  const tone = rate >= 80 ? "text-success" : rate < 50 ? "text-destructive" : "text-warning";
  return (
    <div className={compact ? "" : "min-w-24"}>
      <div className={`font-mono text-[13px] font-semibold tabular-nums ${tone}`}>{rate}%</div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">{metrics.passed}/{metrics.verdicts} · {metrics.checkRate}% checks</div>
    </div>
  );
}

export function HistoryStrip({ history, showBoundaries = true }: { history: PrototypeHistoryPoint[]; showBoundaries?: boolean }) {
  return (
    <div className="flex items-center gap-1">
      {history.map((point, index) => {
        const previous = history[index - 1];
        const definitionChanged = showBoundaries && previous && previous.definition !== point.definition;
        const executionChanged = showBoundaries && previous && previous.execution !== point.execution;
        return (
          <div key={`${point.execution}-${point.model}-${index}`} className="flex items-center gap-1">
            {definitionChanged && <span className="mx-1 h-5 w-px bg-warning" title="Definition changed" />}
            {!definitionChanged && executionChanged && <span className="mx-0.5 h-3 w-px bg-foreground/40" title="Execution changed" />}
            <span
              className={`h-3 w-3 border ${statusClasses(point.status)} ${point.model === "sonnet" ? "outline outline-1 outline-offset-1 outline-muted-foreground/60" : ""}`}
              title={`${point.status} · ${point.definition} · ${point.execution} · ${point.model}`}
            />
          </div>
        );
      })}
    </div>
  );
}

export function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-4 text-[10px] text-muted-foreground">
      <LegendItem className="border-success/50 bg-success/70" label="Passed" />
      <LegendItem className="border-destructive/50 bg-destructive/70" label="Failed" />
      <LegendItem className="border-warning/50 bg-warning/70" label="Error" />
      <span><span className="mr-1.5 inline-block h-3 w-px bg-warning align-middle" />Definition changed</span>
      <span><span className="mr-1.5 inline-block h-3 w-3 border border-success/50 bg-success/70 outline outline-1 outline-offset-1 outline-muted-foreground/60 align-middle" />Sonnet experiment</span>
    </div>
  );
}

function Scope({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <span className="text-muted-foreground"><span className="mr-1 text-muted-foreground/60">{label}</span><span className={`${mono ? "font-mono" : ""} text-foreground`}>{value}</span></span>;
}

function LegendItem({ className, label }: { className: string; label: string }) {
  return <span><span className={`mr-1.5 inline-block h-2.5 w-2.5 border align-middle ${className}`} />{label}</span>;
}

function statusClasses(status: PrototypeHistoryPoint["status"]) {
  if (status === "passed") return "border-success/50 bg-success/70";
  if (status === "failed") return "border-destructive/50 bg-destructive/70";
  return "border-warning/50 bg-warning/70";
}
