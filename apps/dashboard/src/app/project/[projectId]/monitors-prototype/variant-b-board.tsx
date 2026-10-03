// PROTOTYPE — Variant B: monitor status board. No editor on the page — the
// board IS the page: one dense row per monitor with a real evaluation
// sparkline, threshold line, and breach markers, respan's Metrics tab made
// the default view.

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MONITOR_METRICS,
  breaches,
  formatMetricValue,
  formatThreshold,
  relativeTime,
  triggerSentence,
  whereSummary,
  type MonitorStub,
  type SeriesPoint,
} from "./monitors-data";
import { MonitorStateChip, MonitorStateDot } from "./monitor-bits";

interface VariantBProps {
  monitors: MonitorStub[];
}

export default function VariantBBoard({ monitors }: VariantBProps) {
  const breachedCount = monitors.filter((m) => m.breached).length;
  const pausedCount = monitors.filter((m) => m.lifecycle === "paused").length;
  const draftCount = monitors.filter((m) => m.lifecycle === "draft").length;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold tracking-tight">
            Automations
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Capability guarantees over your suites — each row is a standing
            claim the evaluator re-checks every 5 minutes.
          </p>
        </div>
        <Button type="button" className="h-8 text-xs">
          <Plus className="size-4" aria-hidden />
          New Automation
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border border-border bg-card px-4 py-3">
        <p className="text-xs text-muted-foreground">
          <span
            className={`mr-1.5 font-mono text-[18px] tabular-nums ${
              breachedCount > 0 ? "text-destructive" : "text-foreground"
            }`}
          >
            {breachedCount}
          </span>
          breached
        </p>
        <p className="text-xs text-muted-foreground">
          <span className="mr-1.5 font-mono text-[18px] tabular-nums">
            {monitors.length - breachedCount - pausedCount - draftCount}
          </span>
          holding
        </p>
        <p className="text-xs text-muted-foreground">
          <span className="mr-1.5 font-mono text-[18px] tabular-nums">
            {pausedCount}
          </span>
          paused
        </p>
        <p className="text-xs text-muted-foreground">
          <span className="mr-1.5 font-mono text-[18px] tabular-nums">
            {draftCount}
          </span>
          draft
        </p>
        <p className="ml-auto text-xs text-muted-foreground">
          evaluator · every 5m · last pass {relativeTime(monitors[0]?.series.at(-1)?.at ?? null)}
        </p>
      </div>

      <div className="divide-y divide-border border border-border bg-card">
        {monitors.map((monitor) => (
          <div
            key={monitor.id}
            className="grid grid-cols-[minmax(0,1fr)_220px_190px_150px] items-center gap-4 px-4 py-3 transition-colors hover:bg-accent/30"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <MonitorStateDot monitor={monitor} />
                <span className="truncate text-[13px] font-medium">
                  {monitor.name}
                </span>
                <MonitorStateChip monitor={monitor} />
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {triggerSentence(monitor)} · {whereSummary(monitor.where)}
              </p>
            </div>
            <Sparkline monitor={monitor} />
            <div className="text-right">
              <p className="font-mono text-[13px] tabular-nums">
                <span className={monitor.breached ? "text-destructive" : ""}>
                  {formatMetricValue(monitor.metric, monitor.currentValue)}
                </span>
                <span className="text-muted-foreground"> / </span>
                <span className="text-muted-foreground">
                  {formatThreshold(monitor.metric, monitor.threshold)}
                </span>
              </p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {MONITOR_METRICS[monitor.metric].label.toLowerCase()} vs
                threshold · {monitor.window} window
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums">
                {monitor.fires.length} alert{monitor.fires.length === 1 ? "" : "s"}
              </span>
              <span>·</span>
              <span>last {relativeTime(monitor.fires[0]?.at ?? null)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Sparkline({ monitor }: { monitor: MonitorStub }) {
  const series: SeriesPoint[] = monitor.series;
  const width = 220;
  const height = 44;
  const pad = 4;
  const values = series
    .map((p) => p.value)
    .filter((v): v is number => v !== null);
  if (values.length < 2) {
    return (
      <p className="text-[10px] text-muted-foreground">No evaluations yet</p>
    );
  }
  const min = Math.min(...values, monitor.threshold);
  const max = Math.max(...values, monitor.threshold);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (series.length - 1)) * (width - 2 * pad);
  const y = (v: number) =>
    height - pad - ((v - min) / span) * (height - 2 * pad);

  const linePoints = series
    .map((p, i) => (p.value === null ? null : `${x(i)},${y(p.value)}`))
    .filter((s): s is string => s !== null)
    .join(" ");

  return (
    <svg
      role="img"
      aria-label={`${monitor.name} — last ${series.length} evaluations`}
      width={width}
      height={height}
      className="text-foreground"
    >
      <line
        x1={pad}
        x2={width - pad}
        y1={y(monitor.threshold)}
        y2={y(monitor.threshold)}
        stroke="currentColor"
        strokeOpacity="0.35"
        strokeDasharray="3 3"
      />
      <polyline
        points={linePoints}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.8"
        strokeWidth="1.5"
      />
      {series.map((p, i) =>
        p.value !== null &&
        breaches(monitor.operator, p.value, monitor.threshold) ? (
          <rect
            key={i}
            x={x(i) - 2}
            y={y(p.value) - 2}
            width="4"
            height="4"
            className="fill-destructive"
          />
        ) : null,
      )}
    </svg>
  );
}
