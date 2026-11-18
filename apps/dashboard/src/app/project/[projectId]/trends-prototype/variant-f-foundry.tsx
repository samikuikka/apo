// PROTOTYPE · Variant F: the TrueFoundry-shaped layout from the reference
// moodboard, adapted to apo. Hero number first, ONE main chart carrying one
// story (graded pass rate), model attribution in a quiet era band under the
// chart instead of labels on the canvas, then small metric panels below.
// Deliberately tests type sizes above the current design-system scale; see
// NOTES.md. Throwaway.

"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkline } from "./chart-bits";
import {
  TREND_WINDOW,
  formatCompact,
  formatDateTick,
  formatDateWithTime,
  formatPercent,
  gradedRate,
  shortModel,
  type TaskLatestResult,
  type TrendPoint,
} from "./trends-data";

const HEIGHT = 240;
const PAD = { top: 14, right: 14, bottom: 22, left: 40 };

export default function VariantFFoundry({
  projectId,
  points,
  taskResults,
}: {
  projectId: string;
  points: TrendPoint[];
  taskResults: TaskLatestResult[];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(880);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width;
      if (measured) setWidth(measured);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const n = points.length;
  const rates = points.map(gradedRate);
  const last = points[n - 1];

  // Hero = tasks whose latest run passed, the number a reader can hold.
  // Checks aggregate is the supporting stat; a single run's check rate is
  // not a hero (on 1-task batches it is just that task's last run).
  const passing = taskResults.filter((t) => t.status === "passed").length;
  const totalTasks = taskResults.length;
  const windowPassed = points.reduce((acc, p) => acc + p.passedChecks, 0);
  const windowTotal = points.reduce((acc, p) => acc + p.totalChecks, 0);
  const windowRate = windowTotal > 0 ? windowPassed / windowTotal : null;

  // Plain-language trend: graded rate of the last third of the window vs
  // the first third, in points.
  const graded = rates.filter((r): r is number => r !== null);
  const third = Math.max(1, Math.floor(graded.length / 3));
  const early = graded.slice(0, third);
  const late = graded.slice(-third);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const trendPts =
    early.length > 0 && late.length > 0
      ? Math.round((avg(late) - avg(early)) * 100)
      : null;

  const innerW = Math.max(10, width - PAD.left - PAD.right);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (i / (n - 1)) * innerW;
  const y = (v: number) => PAD.top + innerH - v * innerH;

  const segments: string[][] = [];
  let current: string[] = [];
  rates.forEach((rate, i) => {
    if (rate === null) {
      if (current.length > 1) segments.push(current);
      current = [];
    } else {
      current.push(`${x(i)},${y(rate)}`);
    }
  });
  if (current.length > 1) segments.push(current);

  const markerIndices = points
    .map((point, i) =>
      i > 0 && point.models.join("\u0000") !== points[i - 1].models.join("\u0000")
        ? i
        : null,
    )
    .filter((i): i is number => i !== null);

  const tickIndices = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => Math.round(t * (n - 1)))
    .filter((v, i, arr) => arr.indexOf(v) === i);

  // Contiguous same-model eras → the quiet attribution band. Label only
  // eras wide enough to hold their name; the tooltip carries the rest.
  const eras: {
    runs: number;
    firstIndex: number;
    label: string;
    title: string;
  }[] = [];
  points.forEach((point, i) => {
    const label = point.models.map(shortModel).join(" · ") || "unknown model";
    const prev = eras[eras.length - 1];
    if (prev && prev.label === label) prev.runs += 1;
    else eras.push({ runs: 1, firstIndex: i, label, title: point.models.join(" · ") });
  });

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;
  const hoveredRate = hoverIndex !== null ? rates[hoverIndex] : null;

  const costs = points.map((p) => p.totalCost);
  const tokens = points.map((p) => p.totalTokens);
  const errors = points.map((p) => p.erroredTasks);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <h1 className="text-[18px] font-semibold tracking-tight">
          Run Trends
        </h1>
        <p className="flex items-baseline gap-2">
          <span className="font-mono text-[28px] leading-none font-semibold tabular-nums">
            {totalTasks > 0 ? `${passing}/${totalTasks}` : "—"}
          </span>
          <span className="text-xs text-muted-foreground">tasks passing</span>
          {trendPts !== null && trendPts !== 0 ? (
            <span
              className={`font-mono text-xs tabular-nums ${trendPts > 0 ? "text-success" : "text-destructive"}`}
            >
              {trendPts > 0 ? `↑ ${trendPts}` : `↓ ${-trendPts}`} pts
            </span>
          ) : null}
        </p>
        <p className="flex items-baseline gap-2">
          <span className="font-mono text-sm leading-none font-semibold tabular-nums">
            {windowRate !== null ? formatPercent(windowRate) : "—"}
          </span>
          <span className="text-xs text-muted-foreground">checks passed</span>
        </p>
        <p className="ml-auto text-xs text-muted-foreground">
          last {Math.min(n, TREND_WINDOW)} runs
        </p>
      </header>

      <div
        ref={containerRef}
        className="relative"
        title="Each point is one run · height is the share of that run's checks that passed · thin lines mark model switches · a red tick is a run that errored before any check ran"
      >
        <svg
          role="img"
          aria-label={`Graded checks pass rate over the last ${n} runs`}
          width={width}
          height={HEIGHT}
          className="text-foreground"
        >
          {[0, 0.5, 1].map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(t)}
                y2={y(t)}
                className="stroke-border"
              />
              <text
                x={PAD.left - 8}
                y={y(t) + 3}
                textAnchor="end"
                fontSize="10"
                className="fill-muted-foreground"
              >
                {Math.round(t * 100)}
              </text>
            </g>
          ))}

          {markerIndices.map((i) => (
            <line
              key={i}
              x1={x(i)}
              x2={x(i)}
              y1={PAD.top}
              y2={PAD.top + innerH}
              className="stroke-muted-foreground/30"
            />
          ))}

          {segments.map((segment, i) => (
            <polyline
              key={i}
              points={segment.join(" ")}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
          ))}

          {rates.map((rate, i) =>
            rate === null ? (
              <line
                key={i}
                x1={x(i)}
                x2={x(i)}
                y1={PAD.top + innerH - 6}
                y2={PAD.top + innerH}
                strokeWidth="2"
                className="stroke-destructive"
              />
            ) : null,
          )}

          {tickIndices.map((i) => (
            <text
              key={i}
              x={x(i)}
              y={HEIGHT - 6}
              textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              fontSize="10"
              className="fill-muted-foreground"
            >
              {formatDateTick(points[i].createdAt)}
            </text>
          ))}

          {hoverIndex !== null && hoveredRate !== null ? (
            <circle
              cx={x(hoverIndex)}
              cy={y(hoveredRate)}
              r="4"
              className="fill-background stroke-foreground"
            />
          ) : null}

          <rect
            aria-hidden
            x={PAD.left}
            y={PAD.top}
            width={innerW}
            height={innerH}
            fill="transparent"
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const ratio = (event.clientX - rect.left) / rect.width;
              setHoverIndex(
                Math.min(n - 1, Math.max(0, Math.round(ratio * (n - 1)))),
              );
            }}
            onMouseLeave={() => setHoverIndex(null)}
          />
        </svg>

        {hovered ? (
          <div
            className="pointer-events-none absolute w-52 border border-border bg-popover p-2 text-xs"
            style={{
              left: Math.min(
                Math.max(x(hoverIndex ?? 0) - 100, 0),
                width - 208,
              ),
              top: 20,
            }}
          >
            <p className="text-muted-foreground">
              {formatDateWithTime(hovered.createdAt)}
            </p>
            <p className="mt-1 font-mono tabular-nums">
              {hovered.totalChecks > 0
                ? `${hovered.passedChecks}/${hovered.totalChecks} checks (${formatPercent(hovered.passedChecks / hovered.totalChecks)})`
                : "no completed checks"}
            </p>
            <p className="mt-1 truncate text-muted-foreground">
              {hovered.models.length > 0
                ? hovered.models.map(shortModel).join(" · ")
                : "unknown model"}
            </p>
            <a
              href={`/project/${projectId}/runs/${hovered.batchRunId}`}
              className="pointer-events-auto text-primary underline underline-offset-4"
            >
              Open run
            </a>
          </div>
        ) : null}
      </div>

      <div
        className="flex h-6 overflow-hidden border border-border"
        aria-label="Model eras across the window"
      >
        {eras.map((era) => {
          const share = era.runs / n;
          return (
            <div
              key={`${era.label}-${era.runs}`}
              title={`${era.title} · ${era.runs} runs`}
              className={`flex min-w-0 items-center justify-center ${share > 0.5 ? "bg-secondary" : "bg-muted"}`}
              style={{ flexGrow: era.runs }}
            >
              {share >= 0.12 ? (
                <span className="truncate px-2 text-[10px] text-muted-foreground">
                  {era.label}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <MetricPanel
          label="Cost / run"
          values={costs}
          lastLabel={
            last.totalCost !== null ? `$${last.totalCost.toFixed(2)}` : "—"
          }
          delta={pctDelta(costs)}
          format={(v) => `$${v.toFixed(2)}`}
        />
        <MetricPanel
          label="Tokens / run"
          values={tokens}
          lastLabel={
            last.totalTokens !== null ? formatCompact(last.totalTokens) : "—"
          }
          delta={pctDelta(tokens)}
          format={(v) => formatCompact(v)}
        />
        <MetricPanel
          label="Errored tasks / run"
          values={errors}
          lastLabel={String(last.erroredTasks)}
          delta={null}
          format={(v) => String(Math.round(v))}
          alert={last.erroredTasks > 0}
        />
      </div>
    </div>
  );
}

function pctDelta(values: (number | null)[]): number | null {
  const lastVal = [...values].reverse().find((v) => v !== null) ?? null;
  const firstVal = values.find((v) => v !== null) ?? null;
  if (lastVal === null || firstVal === null || firstVal === 0) return null;
  return Math.round(((lastVal - firstVal) / firstVal) * 100);
}

function MetricPanel({
  label,
  values,
  lastLabel,
  delta,
  format,
  alert = false,
}: {
  label: string;
  values: (number | null)[];
  lastLabel: string;
  delta: number | null;
  format: (v: number) => string;
  alert?: boolean;
}) {
  const nonNull = values.filter((v): v is number => v !== null);
  const peak = nonNull.length > 0 ? Math.max(...nonNull) : null;
  return (
    <section className="flex flex-col gap-3 border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-xs text-muted-foreground">{label}</h2>
        {delta !== null && delta !== 0 ? (
          <span
            className={`font-mono text-[11px] tabular-nums ${delta > 0 ? "text-muted-foreground" : "text-success"}`}
          >
            {delta > 0 ? `+${delta}%` : `${delta}%`} vs window start
          </span>
        ) : null}
      </div>
      <p
        className={`font-mono text-2xl leading-none font-semibold tabular-nums ${alert ? "text-destructive" : "text-foreground"}`}
      >
        {lastLabel}
      </p>
      {nonNull.length > 1 ? (
        <Sparkline values={values} width={260} height={36} />
      ) : (
        <p className="text-xs text-muted-foreground">No data in window</p>
      )}
      <p className="text-[11px] text-muted-foreground">
        peak {peak !== null ? format(peak) : "—"} · {nonNull.length}/
        {values.length} runs with data
      </p>
    </section>
  );
}
