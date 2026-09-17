"use client";

import Link from "next/link";
import { useState } from "react";

import type { AgentTaskRunSummary } from "@/lib/agent-task-api";
import { formatCostMicro, formatDuration, tokenFormat } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * PROTOTYPE — per-task columns with the standard chart interaction pair:
 * hover for a glanceable tooltip (task + both runs' value), click to pin a
 * detail card with the full comparison (every metric, verdicts, models) and
 * links into each run's page. Click another column or the ✕ to unpin.
 */
type Metric = "cost" | "duration" | "checks";

interface Column {
  label: string;
  left: AgentTaskRunSummary;
  right: AgentTaskRunSummary;
}

function metricValue(metric: Metric, run: AgentTaskRunSummary): number | null {
  if (metric === "cost") return run.total_cost != null && run.total_cost > 0 ? run.total_cost : null;
  if (metric === "duration") {
    if (!run.started_at || !run.completed_at) return null;
    const ms = new Date(run.completed_at).getTime() - new Date(run.started_at).getTime();
    return ms > 0 ? ms : null;
  }
  return run.total_checks > 0 ? run.passed_checks : null;
}

function fmtMetric(metric: Metric, v: number): string {
  if (metric === "cost") return formatCostMicro(v);
  if (metric === "duration") return formatDuration(v);
  return String(v);
}

function runDuration(run: AgentTaskRunSummary): number | null {
  if (!run.started_at || !run.completed_at) return null;
  const ms = new Date(run.completed_at).getTime() - new Date(run.started_at).getTime();
  return ms > 0 ? ms : null;
}

function runModel(run: AgentTaskRunSummary): string {
  return run.run_configuration?.model ?? run.primary_model ?? "—";
}

export function TaskColumns({
  leftRuns,
  rightRuns,
  projectId,
}: {
  leftRuns: AgentTaskRunSummary[];
  rightRuns: AgentTaskRunSummary[];
  projectId: string;
}) {
  const [metric, setMetric] = useState<Metric>("cost");
  const [hovered, setHovered] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  const rightByPath = new Map(rightRuns.map((r) => [r.task_path, r]));
  const columns: Column[] = [];
  for (const left of leftRuns) {
    const right = rightByPath.get(left.task_path);
    if (!right) continue;
    if (metricValue(metric, left) == null || metricValue(metric, right) == null) continue;
    columns.push({ label: left.task_path.split("/").pop() ?? left.task_path, left, right });
  }
  columns.sort((x, y) => {
    const mx = (c: Column) => Math.max(metricValue(metric, c.left) ?? 0, metricValue(metric, c.right) ?? 0);
    return mx(y) - mx(x);
  });

  const L = 60;
  const R = 12;
  const T = 20;
  const B = 66;
  const H = 340;
  const COL = 64;
  const width = Math.max(560, L + R + columns.length * COL);
  const maxY = Math.max(1, ...columns.map((c) => Math.max(metricValue(metric, c.left) ?? 0, metricValue(metric, c.right) ?? 0)));
  const sy = (v: number) => H - B - (v / maxY) * (H - T - B);
  const bBetter = (c: Column) => {
    const a = metricValue(metric, c.left)!;
    const b = metricValue(metric, c.right)!;
    return metric === "checks" ? b > a : b < a;
  };
  const bWorse = (c: Column) => {
    const a = metricValue(metric, c.left)!;
    const b = metricValue(metric, c.right)!;
    return metric === "checks" ? b < a : b > a;
  };

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxY);
  const metricName = metric === "cost" ? "cost" : metric === "duration" ? "duration" : "checks passed";
  const metrics: { key: Metric; label: string; hint: string }[] = [
    { key: "cost", label: "cost", hint: "up = more expensive" },
    { key: "duration", label: "duration", hint: "up = slower" },
    { key: "checks", label: "checks", hint: "up = more checks passed" },
  ];

  const activeIdx = pinned ?? hovered;
  const active = activeIdx != null ? columns[activeIdx] : null;

  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="font-medium uppercase tracking-wider text-muted-foreground">per task</span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full border border-muted-foreground bg-card" aria-hidden /> Run A
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-foreground" aria-hidden /> Run B
          </span>
          <span className="hidden text-muted-foreground/50 sm:inline">click a column for detail</span>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          {metrics.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMetric(m.key)}
              title={m.hint}
              className={
                metric === m.key
                  ? "rounded bg-foreground/10 px-2 py-0.5 font-mono text-[11px] text-foreground"
                  : "rounded px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
              }
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {columns.length === 0 ? (
        <div className="py-4 text-[12px] text-muted-foreground">No shared tasks report this metric.</div>
      ) : (
        <div
          className="relative mt-2 overflow-x-auto"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
          }}
          onMouseLeave={() => setHovered(null)}
        >
          <svg
            viewBox={`0 0 ${width} ${H}`}
            width={width}
            height={H}
            role="img"
            aria-label={`Per-task ${metricName} comparison`}
            onClick={() => setPinned(null)}
          >
            {yTicks.map((t, i) => (
              <g key={i}>
                <line x1={L} x2={width - R} y1={sy(t)} y2={sy(t)} stroke="currentColor" strokeWidth="1" className="text-border/60" />
                <text x={L - 6} y={sy(t) + 3} textAnchor="end" className="fill-current font-mono text-[10px] text-muted-foreground/60">
                  {t === 0 ? (metric === "cost" ? "$0" : "0") : fmtMetric(metric, Math.round(t))}
                </text>
              </g>
            ))}
            <text x={4} y={T - 4} className="fill-current text-[10px] text-muted-foreground/70">
              {metricName} ↑
            </text>

            {columns.map((c, i) => {
              const x = L + i * COL + COL / 2;
              const a = metricValue(metric, c.left)!;
              const b = metricValue(metric, c.right)!;
              const top = sy(Math.max(a, b));
              const bottom = sy(Math.min(a, b));
              const isActive = activeIdx === i;
              const line = a === b ? "text-border" : bBetter(c) ? "text-success/80" : bWorse(c) ? "text-destructive/80" : "text-muted-foreground/40";
              return (
                <g
                  key={`${c.label}-${i}`}
                  className="cursor-pointer"
                  onMouseEnter={() => setHovered(i)}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPinned(pinned === i ? null : i);
                  }}
                >
                  <title>{`${c.label}: A ${fmtMetric(metric, a)} → B ${fmtMetric(metric, b)} — click for detail`}</title>
                  {isActive && (
                    <rect x={x - COL / 2 + 2} y={T - 6} width={COL - 4} height={H - T - B + 10} rx="3" className="fill-current text-foreground/[0.04]" />
                  )}
                  <rect x={x - COL / 2 + 4} y={T} width={COL - 8} height={H - T - B} fill="transparent" />
                  <line x1={x} x2={x} y1={top} y2={bottom} stroke="currentColor" strokeWidth="2" className={line} />
                  <circle cx={x} cy={sy(a)} r="4.5" fill="var(--color-card, #18181b)" strokeWidth="1.5" className="stroke-current text-muted-foreground" />
                  <circle cx={x} cy={sy(b)} r="4.5" className="fill-current text-foreground" />
                  <text
                    x={x}
                    y={H - B + 14}
                    textAnchor="end"
                    transform={`rotate(-32 ${x} ${H - B + 14})`}
                    className={cn("fill-current font-mono text-[10px]", isActive ? "text-foreground" : "text-muted-foreground/80")}
                  >
                    {c.label.length > 16 ? `${c.label.slice(0, 15)}…` : c.label}
                  </text>
                </g>
              );
            })}
          </svg>

          {/* hover tooltip — glanceable, follows the cursor */}
          {hovered != null && pinned == null && cursor && columns[hovered] && (
            <div
              className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] shadow-md"
              style={{ left: cursor.x, top: cursor.y, transform: "translate(-50%, -115%)" }}
            >
              <div className="font-mono font-medium text-foreground">{columns[hovered].label}</div>
              <div className="mt-0.5 font-mono tabular-nums text-muted-foreground">
                A {fmtMetric(metric, metricValue(metric, columns[hovered].left)!)} → B {fmtMetric(metric, metricValue(metric, columns[hovered].right)!)}
              </div>
              <div className="text-[10px] text-muted-foreground/60">click for detail</div>
            </div>
          )}
        </div>
      )}

      {/* pinned detail card — the committed inspection */}
      {active && (
        <div className="mt-3 rounded-md border border-border bg-muted/20 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 truncate font-mono text-[13px] font-medium text-foreground">{active.label}</div>
            <button
              type="button"
              onClick={() => setPinned(null)}
              className="shrink-0 rounded px-1.5 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Close detail"
            >
              ✕
            </button>
          </div>
          <div className="mt-2 grid grid-cols-[92px_minmax(0,1fr)_minmax(0,1fr)] gap-x-3 text-[12px]">
            <div />
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Run A</div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Run B</div>
            {(
              [
                { label: "verdict", a: active.left.status, b: active.right.status },
                {
                  label: "checks",
                  a: `${active.left.passed_checks}/${active.left.total_checks}`,
                  b: `${active.right.passed_checks}/${active.right.total_checks}`,
                },
                {
                  label: "cost",
                  a: active.left.total_cost != null && active.left.total_cost > 0 ? formatCostMicro(active.left.total_cost) : "—",
                  b: active.right.total_cost != null && active.right.total_cost > 0 ? formatCostMicro(active.right.total_cost) : "—",
                },
                {
                  label: "duration",
                  a: runDuration(active.left) != null ? formatDuration(runDuration(active.left)) : "—",
                  b: runDuration(active.right) != null ? formatDuration(runDuration(active.right)) : "—",
                },
                {
                  label: "tokens",
                  a: active.left.total_tokens ? tokenFormat(active.left.total_tokens) : "—",
                  b: active.right.total_tokens ? tokenFormat(active.right.total_tokens) : "—",
                },
                { label: "model", a: runModel(active.left), b: runModel(active.right) },
              ] as { label: string; a: string; b: string }[]
            ).map((row) => (
              <div key={row.label} className="col-span-3 grid grid-cols-subgrid items-baseline border-t border-border/50 py-1">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground/70">{row.label}</div>
                <div className="truncate font-mono text-[12px] tabular-nums text-foreground">{row.a}</div>
                <div className="truncate font-mono text-[12px] tabular-nums text-foreground">{row.b}</div>
              </div>
            ))}
            <div className="col-span-3 grid grid-cols-subgrid items-baseline border-t border-border/50 py-1">
              <div />
              <Link
                href={`/project/${projectId}/runs/task/${active.left.id}`}
                className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Open run A →
              </Link>
              <Link
                href={`/project/${projectId}/runs/task/${active.right.id}`}
                className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Open run B →
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
