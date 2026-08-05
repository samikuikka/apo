import type { PrototypeHistoryPoint, PrototypeMetrics, PrototypeTaskOverview } from "./data";
import { BASELINE_SCOPE, passRate } from "./data";
import type { PrototypeRunV2, RunConfig } from "./data-v2";
import { describeConfig, shortSha } from "./data-v2";
import { Filter } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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

// ---------------------------------------------------------------------------
// v2 shared components — used by the cohort, schedule, and filters variants
// ---------------------------------------------------------------------------

/**
 * Generic segmented filter control. One per dimension (model, revision,
 * trigger, etc.). `value === "all"` is the "no filter" state — the page
 * opens with every dimension on "all" so users see the honest total first
 * and then narrow.
 */
export interface FilterOption {
  value: string; // use the literal "all" for the unfiltered state
  label: string;
  count: number;
}

export function FilterGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: FilterOption[];
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="mr-1 text-[10px] uppercase tracking-wide text-muted-foreground/80">{label}</span>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`border px-2 py-1 text-[11px] transition-colors ${active ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:text-foreground"}`}
          >
            {opt.label}
            <span className={`ml-1.5 ${active ? "text-background/70" : "text-muted-foreground/60"}`}>{opt.count}</span>
          </button>
        );
      })}
    </div>
  );
}

export function TaskIdentityV2({ name, folder, tag }: { name: string; folder: string; tag: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[13px] font-semibold">{name}</div>
      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="font-mono">{folder}</span>
        <span className="border border-border px-1">{tag}</span>
      </div>
    </div>
  );
}

export function WarningChip({ children, tone = "warning" }: { children: React.ReactNode; tone?: "warning" | "muted" | "info" }) {
  const cls = tone === "warning" ? "border-warning/40 text-warning" : tone === "muted" ? "border-border text-muted-foreground" : "border-foreground/30 text-foreground/70";
  return <span className={`border ${cls} px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide`}>{children}</span>;
}

export function SampleSize({ n, label = "runs" }: { n: number; label?: string }) {
  if (n === 0) return <span className="text-[10px] text-muted-foreground/60">no runs</span>;
  if (n === 1) return <span className="text-[10px] text-warning">1 {label.replace("s", "")} · low confidence</span>;
  return <span className="text-[10px] text-muted-foreground">{n} {label}</span>;
}

/**
 * One-line "why this is the baseline" summary. The cheapest, highest-leverage
 * trust fix: every baseline number gets a sentence underneath explaining
 * where it came from.
 */
export function EvidenceLine({ run, count, showTrigger = true }: { run: PrototypeRunV2; count?: number; showTrigger?: boolean }) {
  const triggerLabel = showTrigger ? triggerPill(run.trigger) : null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
      {triggerLabel && <span className="border border-border/70 px-1 text-foreground/70">{triggerLabel}</span>}
      <span>{describeConfig(run.config)}</span>
      <span aria-hidden>·</span>
      <span className="font-mono">{shortSha(run.sourceCommitSha)}</span>
      {run.taskRevision.dirty && <span className="text-warning">dirty</span>}
      {typeof count === "number" && (
        <>
          <span aria-hidden>·</span>
          <span>{count} in cohort</span>
        </>
      )}
    </div>
  );
}

export function EmptyBaseline({ reason }: { reason: string }) {
  return (
    <div className="flex h-full flex-col justify-center rounded-sm border border-dashed border-border/70 bg-card/20 px-3 py-2 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground/70">No baseline</span>
      <span className="mt-0.5 text-[10px]">{reason}</span>
    </div>
  );
}

export interface ModelOption {
  config: RunConfig | null; // null = "all models"
  label: string;
  count: number;
}

export function ModelPicker({ options, value, onChange }: { options: ModelOption[]; value: RunConfig | null; onChange: (v: RunConfig | null) => void }) {
  return (
    <div className="flex items-center gap-1">
      <span className="mr-1 text-[10px] uppercase tracking-wide text-muted-foreground">Model</span>
      {options.map((opt) => {
        const active = (opt.config?.model ?? null) === (value?.model ?? null) && (opt.config?.effort ?? null) === (value?.effort ?? null) && (opt.config === null) === (value === null);
        return (
          <button
            key={opt.label}
            type="button"
            onClick={() => onChange(opt.config)}
            className={`border px-2 py-1 text-[11px] transition-colors ${active ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:text-foreground"}`}
          >
            {opt.label}
            <span className={`ml-1.5 ${active ? "text-background/70" : "text-muted-foreground/60"}`}>{opt.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Compact run strip. `counted` marks runs that contributed to the current
 * baseline; the rest are dimmed so users see what was excluded and why.
 */
export function RunStrip({ runs, counted }: { runs: PrototypeRunV2[]; counted: (r: PrototypeRunV2) => boolean }) {
  if (runs.length === 0) return <span className="text-[10px] text-muted-foreground/60">no history</span>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {runs.map((r) => {
        const isIn = counted(r);
        return (
          <span
            key={r.id}
            title={`${r.status} · ${r.trigger} · ${describeConfig(r.config)} · ${shortSha(r.sourceCommitSha)}`}
            className={`h-2.5 w-2.5 border ${runColor(r.status)} ${isIn ? "" : "opacity-30"} ${r.config.model === "sonnet" ? "outline outline-1 outline-offset-1 outline-muted-foreground/60" : ""}`}
          />
        );
      })}
    </div>
  );
}

function runColor(status: PrototypeRunV2["status"]) {
  if (status === "passed") return "border-success/50 bg-success/70";
  if (status === "failed") return "border-destructive/50 bg-destructive/70";
  return "border-warning/50 bg-warning/70";
}

function triggerPill(trigger: PrototypeRunV2["trigger"]) {
  if (trigger === "schedule") return "scheduled";
  if (trigger === "ci") return "ci";
  if (trigger === "manual") return "manual";
  return "ad-hoc";
}

// ---------------------------------------------------------------------------
// Column-header filter dropdown (Excel/Notion autoFilter style)
// ---------------------------------------------------------------------------

export interface ColumnFilterOption {
  value: string;
  label: string;
  count: number;
}

/**
 * Multi-select column-header filter styled like the traces table. The header
 * is a dropdown trigger; the dropdown shows every distinct value with a
 * checkbox and a count. A small badge appears next to the label when fewer
 * than all values are selected, so users can see at a glance which columns
 * are actively filtering.
 */
export function ColumnFilterHeader({
  label,
  options,
  selected,
  onChange,
  align = "start",
}: {
  label: string;
  options: ColumnFilterOption[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  align?: "start" | "end";
}) {
  const allSelected = selected.size >= options.length;
  const noneSelected = selected.size === 0;

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`group flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider transition-colors hover:text-foreground ${allSelected ? "text-muted-foreground" : "text-foreground"}`}
          aria-label={`Filter by ${label}`}
        >
          <span>{label}</span>
          {!allSelected && (
            <span className={`inline-flex h-3.5 min-w-3.5 items-center justify-center px-1 text-[9px] font-semibold ${noneSelected ? "bg-destructive text-background" : "bg-foreground text-background"}`}>
              {selected.size}
            </span>
          )}
          <Filter className={`h-3 w-3 ${allSelected ? "opacity-30 group-hover:opacity-60" : "opacity-80"}`} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-56">
        <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          <button
            type="button"
            onClick={() => onChange(new Set(options.map((o) => o.value)))}
            className="hover:text-foreground"
          >
            Select all
          </button>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={() => onChange(new Set())}
            className="hover:text-foreground"
          >
            Clear
          </button>
        </div>
        <DropdownMenuSeparator />
        {options.map((opt) => {
          const checked = selected.has(opt.value);
          return (
            <DropdownMenuCheckboxItem
              key={opt.value}
              checked={checked}
              onCheckedChange={() => toggle(opt.value)}
              className="text-xs"
            >
              <span className="flex-1 truncate">{opt.label}</span>
              <span className="ml-2 font-mono text-[10px] text-muted-foreground">{opt.count}</span>
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Plain (non-filter) header matching `ColumnFilterHeader` typography. */
export function PlainHeader({ label, align = "left" }: { label: string; align?: "left" | "right" }) {
  return (
    <span className={`block text-[11px] font-medium uppercase tracking-wider text-muted-foreground ${align === "right" ? "text-right" : ""}`}>
      {label}
    </span>
  );
}
