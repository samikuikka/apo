// PROTOTYPE · Variant A: one graded pass-rate line over the last 60 batch
// runs, with model-change markers and cost/token sparklines below. The y
// domain is pinned to 0..1: a zoomed axis turns noise into drama (the
// Jenkins non-zero-axis failure mode).

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
  type TrendPoint,
} from "./trends-data";

const HEIGHT = 200;
const PAD = { top: 32, right: 14, bottom: 20, left: 34 };

export default function VariantAChecks({
  projectId,
  points,
}: {
  projectId: string;
  points: TrendPoint[];
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

  const rates = points.map(gradedRate);
  const lastPoint = points.at(-1) ?? null;
  const lastRate = lastPoint ? gradedRate(lastPoint) : null;
  const innerW = Math.max(10, width - PAD.left - PAD.right);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const n = points.length;
  // n === 1 (a project's only batch run) would divide by zero and place
  // every coordinate at NaN; a single point sits at the left edge instead.
  const x = (i: number) => PAD.left + (i / Math.max(1, n - 1)) * innerW;
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

  const modelMarkers = points
    .map((point, i) => {
      if (i === 0) return null;
      return point.models.join("\u0000") !== points[i - 1].models.join("\u0000")
        ? { i, label: point.models.map(shortModel).join(" · ") }
        : null;
    })
    .filter((m): m is { i: number; label: string } => m !== null);

  // Dense switch periods produce marker labels that collide into an
  // unreadable run. Stagger two rows above the plot, greedy left to right,
  // flip the anchor at the right edge, drop a label neither row can fit
  // (the marker line and the hover tooltip still carry it).
  const rowEnd: [number, number] = [-Infinity, -Infinity];
  const placedMarkers = modelMarkers.flatMap((marker) => {
    const estWidth = marker.label.length * 5.5;
    const overflow = x(marker.i) + 3 + estWidth > width - PAD.right;
    const startX = overflow ? x(marker.i) - 3 - estWidth : x(marker.i) + 3;
    const row = rowEnd[0] + 8 <= startX ? 0 : rowEnd[1] + 8 <= startX ? 1 : -1;
    if (row === -1) return [];
    rowEnd[row] = startX + estWidth;
    return [{ ...marker, row, overflow }];
  });

  const tickIndices = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => Math.round(t * (n - 1)))
    .filter((v, i, arr) => arr.indexOf(v) === i);

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;
  const hoveredRate = hoverIndex !== null ? rates[hoverIndex] : null;

  const costs = points.map((p) => p.totalCost);
  const tokens = points.map((p) => p.totalTokens);
  const lastCost = lastNonNull(costs);
  const lastTokens = lastNonNull(tokens);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-[18px] font-semibold tracking-tight">
          Run Trends
        </h1>
        <p className="mt-1 flex items-baseline gap-2">
          <span className="font-mono text-[18px] tabular-nums">
            {lastRate !== null ? formatPercent(lastRate) : "—"}
          </span>
          <span className="text-xs text-muted-foreground">
            graded pass rate · last {Math.min(n, TREND_WINDOW)} runs
          </span>
        </p>
      </header>

      <div ref={containerRef} className="relative">
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
                x={PAD.left - 6}
                y={y(t) + 3}
                textAnchor="end"
                fontSize="10"
                className="fill-muted-foreground"
              >
                {Math.round(t * 100)}
              </text>
            </g>
          ))}

          {placedMarkers.map((marker) => (
            <g key={marker.i}>
              <line
                x1={x(marker.i)}
                x2={x(marker.i)}
                y1={PAD.top}
                y2={PAD.top + innerH}
                className="stroke-muted-foreground/50"
              />
              <text
                x={marker.overflow ? x(marker.i) - 3 : x(marker.i) + 3}
                y={marker.row === 0 ? 12 : 24}
                textAnchor={marker.overflow ? "end" : "start"}
                fontSize="10"
                className="fill-muted-foreground"
              >
                {marker.label}
              </text>
            </g>
          ))}

          {segments.map((segment, i) => (
            <polyline
              key={i}
              points={segment.join(" ")}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
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
              r="3.5"
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
            className="pointer-events-none absolute w-48 border border-border bg-popover p-2 text-xs"
            style={{
              left: Math.min(Math.max(x(hoverIndex ?? 0) - 96, 0), width - 192),
              top: 28,
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

      <div className="flex flex-col gap-2">
        <SparkRow
          label="Cost"
          values={costs}
          lastLabel={lastCost !== null ? `$${lastCost.toFixed(2)}` : null}
          empty="No cost data"
        />
        <SparkRow
          label="Tokens"
          values={tokens}
          lastLabel={lastTokens !== null ? formatCompact(lastTokens) : null}
          empty="No token data"
        />
      </div>
    </div>
  );
}

function lastNonNull(
  values: (number | null)[],
): number | null {
  return values.findLast((v) => v !== null) ?? null;
}

function SparkRow({
  label,
  values,
  lastLabel,
  empty,
}: {
  label: string;
  values: (number | null)[];
  lastLabel: string | null;
  empty: string;
}) {
  const hasData = values.some((v) => v !== null);
  return (
    <div className="flex items-center gap-4 border border-border bg-card px-4 py-2">
      <p className="w-14 shrink-0 text-xs text-muted-foreground">{label}</p>
      {hasData ? (
        <>
          <Sparkline values={values} width={320} height={44} />
          <p className="ml-auto font-mono text-xs tabular-nums">
            {lastLabel ?? "—"}
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}
