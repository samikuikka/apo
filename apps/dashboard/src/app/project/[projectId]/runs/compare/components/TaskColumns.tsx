"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import type { AgentTaskRunSummary } from "@/lib/agent-task-api";
import { formatCostMicro, formatDuration, runDurationMs, tokenFormat } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Per-task columns grouped by folder. Folders are collapsible
 * bands: click a folder label to collapse the whole group into a single
 * aggregated column (Σ per metric), click again to expand. Hover gives the
 * glanceable tooltip; click pins the detail card. The folder grouping is the
 * scaling mechanism — dozens of tasks stay navigable because whole flows can
 * be folded away.
 */
type Metric = "cost" | "duration" | "checks";

/** `passed/total` plus a warning suffix for judge-errored checks (#323). */
function checksCell(run: AgentTaskRunSummary): string {
  const base = `${run.passed_checks}/${run.total_checks}`;
  const errored = run.errored_checks ?? 0;
  return errored > 0 ? `${base} · ${errored} no verdict` : base;
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

function fmtRunDuration(run: AgentTaskRunSummary): string {
  const ms = runDurationMs(run.started_at, run.completed_at);
  return ms != null ? formatDuration(ms) : "—";
}

function runModel(run: AgentTaskRunSummary): string {
  return run.run_configuration?.model ?? run.primary_model ?? "—";
}

const folderOf = (taskPath: string) => {
  const idx = taskPath.lastIndexOf("/");
  return idx > 0 ? taskPath.slice(0, idx) : "";
};

/** One rendered column: a task, or a collapsed folder aggregated.
 *  Columns exist for EVERY shared task regardless of the selected metric —
 *  the X axis never reshuffles when the metric changes; tasks that don't
 *  report the metric show a dash instead of vanishing. */
interface RenderedColumn {
  key: string;
  label: string;
  folder: string;
  left: AgentTaskRunSummary | null;
  right: AgentTaskRunSummary | null;
  aggA: number | null;
  aggB: number | null;
  isFolder: boolean;
  taskCount: number;
}

function buildColumns(
  leftRuns: AgentTaskRunSummary[],
  rightRuns: AgentTaskRunSummary[],
  metric: Metric,
  collapsed: Set<string>,
): { columns: RenderedColumn[] } {
  const rightByPath = new Map(rightRuns.map((r) => [r.task_path, r]));
  const seenPaths = new Set<string>();
  type TaskCol = { label: string; folder: string; left: AgentTaskRunSummary; right: AgentTaskRunSummary };
  const tasks = new Map<string, TaskCol[]>();
  for (const left of leftRuns) {
    if (seenPaths.has(left.task_path)) continue; // one column per task
    seenPaths.add(left.task_path);
    const right = rightByPath.get(left.task_path);
    if (!right) continue;
    const label = left.task_path.split("/").pop() ?? left.task_path;
    const folder = folderOf(left.task_path);
    if (!tasks.has(folder)) tasks.set(folder, []);
    tasks.get(folder)!.push({ label, folder, left, right });
  }
  const folderOrder = Array.from(tasks.keys()).toSorted((a, b) => a.localeCompare(b)); // matches the Tasks tab's flow order
  const columns: RenderedColumn[] = [];
  for (const folder of folderOrder) {
    // alphabetical inside a folder: the same order for every metric, so
    // toggling cost/duration/checks never reshuffles the axis
    const group = (tasks.get(folder)!).toSorted((x, y) => x.label.localeCompare(y.label));
    if (collapsed.has(folder)) {
      // Σ over tasks that report the metric; a side where NOTHING reports
      // stays null (rendered as a dash) instead of a fake zero
      const sum = (side: "left" | "right") => {
        let total: number | null = null;
        for (const t of group) {
          const v = metricValue(metric, t[side]);
          if (v != null) total = (total ?? 0) + v;
        }
        return total;
      };
      columns.push({
        key: `folder:${folder}`,
        label: folder ? folder.split("/").pop()! : "(root)",
        folder,
        left: null,
        right: null,
        aggA: sum("left"),
        aggB: sum("right"),
        isFolder: true,
        taskCount: group.length,
      });
    } else {
      for (const t of group) {
        columns.push({
          key: t.left.task_path,
          label: t.label,
          folder: t.folder,
          left: t.left,
          right: t.right,
          aggA: metricValue(metric, t.left),
          aggB: metricValue(metric, t.right),
          isFolder: false,
          taskCount: 1,
        });
      }
    }
  }
  return { columns };
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  // viewport-fixed tooltip coords — never part of the scrollable content
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  const { columns } = useMemo(
    () => buildColumns(leftRuns, rightRuns, metric, collapsed),
    [leftRuns, rightRuns, metric, collapsed],
  );

  const toggleFolder = (folder: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

  const L = 60;
  const R = 8;
  const T = 34; // folder band labels
  const B = 66;
  const H = 350;
  const COL = 56;
  const FOLDER_GAP = 6;

  // x positions with folder gaps; the plot width hugs the actual content so
  // the scroll container never guards a sliver of empty space
  const xOf: number[] = [];
  let contentRight = L;
  {
    let x = L;
    let prevFolder: string | null = null;
    for (const c of columns) {
      if (prevFolder !== null && c.folder !== prevFolder) x += FOLDER_GAP;
      xOf.push(x + COL / 2);
      x += COL;
      contentRight = x;
      prevFolder = c.folder;
    }
  }
  const width = Math.max(560, contentRight + R);

  const maxY = Math.max(1, ...columns.map((c) => Math.max(c.aggA ?? 0, c.aggB ?? 0)));
  const sy = (v: number) => H - B - (v / maxY) * (H - T - B);
  const bBetter = (c: RenderedColumn) =>
    c.aggA != null && c.aggB != null && (metric === "checks" ? c.aggB > c.aggA : c.aggB < c.aggA);
  const bWorse = (c: RenderedColumn) =>
    c.aggA != null && c.aggB != null && (metric === "checks" ? c.aggB < c.aggA : c.aggB > c.aggA);

  // folder band extents
  const bands: { folder: string; x1: number; x2: number; collapsed: boolean; count: number }[] = [];
  columns.forEach((c, i) => {
    const last = bands[bands.length - 1];
    if (!last || last.folder !== c.folder) {
      bands.push({ folder: c.folder, x1: xOf[i] - COL / 2, x2: xOf[i] + COL / 2, collapsed: c.isFolder, count: c.taskCount });
    } else {
      last.x2 = xOf[i] + COL / 2;
    }
  });

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxY);
  const metricName = metric === "cost" ? "cost" : metric === "duration" ? "duration" : "checks passed";
  const metrics: { key: Metric; label: string; hint: string }[] = [
    { key: "cost", label: "cost", hint: "up = more expensive" },
    { key: "duration", label: "duration", hint: "up = slower" },
    { key: "checks", label: "checks", hint: "up = more checks passed" },
  ];

  const hoveredColumn = hoveredKey != null ? columns.find((c) => c.key === hoveredKey) ?? null : null;
  // hover highlights the column in-place (SVG only, no reflow) and drives
  // the cursor tooltip; the detail card is click-pinned — hovering must
  // never change page height or rewrite content below the chart.
  const activeKey = pinnedKey ?? hoveredKey;
  const active = pinnedKey != null ? columns.find((c) => c.key === pinnedKey) ?? null : null;

  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <span className="font-medium uppercase tracking-wider text-muted-foreground">per task</span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full border border-muted-foreground bg-card" aria-hidden /> Run A
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-foreground" aria-hidden /> Run B
          </span>
          <span className="hidden text-muted-foreground/50 sm:inline">click folder label to fold · click column for detail</span>
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
        <>
          <div
            className="mt-2 overflow-x-auto"
            onMouseMove={(e) => {
              if (hoveredKey == null) return; // no re-render storms while just scrolling
              setCursor({
                x: Math.min(Math.max(e.clientX, 110), window.innerWidth - 110),
                y: Math.max(e.clientY, 70),
              });
            }}
            onMouseLeave={() => setHoveredKey(null)}
          >
            <svg
              viewBox={`0 0 ${width} ${H}`}
              width={width}
              height={H}
              className="block"
              role="group"
              aria-label={`Per-task ${metricName} comparison`}
              onClick={() => setPinnedKey(null)}
            >
              {yTicks.map((t, i) => (
                <g key={i}>
                  <line x1={L} x2={contentRight} y1={sy(t)} y2={sy(t)} stroke="currentColor" strokeWidth="1" className="text-border/60" />
                  <text x={L - 6} y={sy(t) + 3} textAnchor="end" className="fill-current font-mono text-[10px] text-muted-foreground/60">
                    {t === 0 ? (metric === "cost" ? "$0" : "0") : fmtMetric(metric, Math.round(t))}
                  </text>
                </g>
              ))}
              <text x={4} y={T - 8} className="fill-current text-[10px] text-muted-foreground/70">
                {metricName} ↑
              </text>

              {/* folder bands — alternate shading, label toggles collapse */}
              {bands.map((b, i) => (
                <g
                  key={b.folder || "(root)"}
                  className="group cursor-pointer"
                  role="button"
                  tabIndex={0}
                  aria-pressed={b.collapsed}
                  aria-label={`${b.folder || "(root)"} folder — ${b.collapsed ? "expand" : "collapse"} (${b.count} tasks)`}
                  onClick={(e) => { e.stopPropagation(); toggleFolder(b.folder); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      toggleFolder(b.folder);
                    }
                  }}
                >
                  <title>{`${b.folder || "(root)"} — ${b.collapsed ? "expand" : "collapse"} (${b.count} task${b.count === 1 ? "" : "s"})`}</title>
                  <rect
                    x={b.x1 - 2}
                    y={T - 20}
                    width={b.x2 - b.x1 + 4}
                    height={H - T - B + 22}
                    rx="3"
                    fill="currentColor"
                    className={cn(
                      "group-hover:text-foreground/[0.09]",
                      i % 2 === 0 ? "text-foreground/[0.06]" : "text-foreground/[0.025]",
                    )}
                  />
                  <rect
                    x={(b.x1 + b.x2) / 2 - 34}
                    y={T - 30}
                    width="68"
                    height="15"
                    rx="7.5"
                    className="fill-current stroke-current text-card text-border"
                    strokeWidth="1"
                  />
                  <text x={(b.x1 + b.x2) / 2} y={T - 19} textAnchor="middle" className="fill-current font-mono text-[10px] font-medium text-muted-foreground group-hover:fill-foreground">
                    {(b.folder ? b.folder.split("/").pop()! : "(root)") + (b.collapsed ? " ▸" : " ▾")}
                  </text>
                </g>
              ))}

              {columns.map((c, i) => {
                const x = xOf[i];
                const hasValues = c.aggA != null && c.aggB != null;
                const top = sy(Math.max(c.aggA ?? 0, c.aggB ?? 0));
                const bottom = sy(Math.min(c.aggA ?? 0, c.aggB ?? 0));
                const isActive = activeKey === c.key;
                const line =
                  !hasValues
                    ? "text-border"
                    : c.aggA === c.aggB
                      ? "text-border"
                      : bBetter(c)
                        ? "text-success/80"
                        : bWorse(c)
                          ? "text-destructive/80"
                          : "text-muted-foreground/40";
                return (
                  <g
                    key={c.key}
                    className="cursor-pointer"
                    onMouseEnter={() => setHoveredKey(c.key)}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPinnedKey(pinnedKey === c.key ? null : c.key);
                    }}
                  >
                    <title>{`${c.label}: A ${c.aggA != null ? fmtMetric(metric, c.aggA) : "—"} → B ${c.aggB != null ? fmtMetric(metric, c.aggB) : "—"} — click for detail`}</title>
                    {isActive && (
                      <rect x={x - COL / 2 + 2} y={T - 6} width={COL - 4} height={H - T - B + 10} rx="3" className="fill-current text-foreground/[0.05]" />
                    )}
                    <rect x={x - COL / 2 + 4} y={T} width={COL - 8} height={H - T - B} fill="transparent" />
                    {hasValues ? (
                      <>
                        <line x1={x} x2={x} y1={top} y2={bottom} stroke="currentColor" strokeWidth="2" className={line} />
                        <circle cx={x} cy={sy(c.aggA ?? 0)} r="4.5" fill="var(--color-card, #18181b)" strokeWidth="1.5" className="stroke-current text-muted-foreground" />
                        <circle cx={x} cy={sy(c.aggB ?? 0)} r="4.5" className="fill-current text-foreground" />
                      </>
                    ) : (
                      <text x={x} y={sy(0) - 6} textAnchor="middle" className="fill-current font-mono text-[11px] text-muted-foreground/40">
                        —
                      </text>
                    )}
                    <text
                      x={x}
                      y={H - B + 14}
                      textAnchor="end"
                      transform={`rotate(-32 ${x} ${H - B + 14})`}
                      className={cn("fill-current font-mono text-[10px]", isActive ? "text-foreground" : "text-muted-foreground/80")}
                    >
                      {(c.label.length > 16 ? `${c.label.slice(0, 15)}…` : c.label) + (c.isFolder ? ` (${c.taskCount})` : "")}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
          {hoveredColumn && pinnedKey == null && cursor && (
            <div
              className="pointer-events-none fixed z-50 whitespace-nowrap rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] shadow-md"
              style={{ left: cursor.x, top: cursor.y, transform: "translate(-50%, -115%)" }}
            >
              <div className="font-mono font-medium text-foreground">{hoveredColumn.label}</div>
              <div className="mt-0.5 font-mono tabular-nums text-muted-foreground">
                A {hoveredColumn.aggA != null ? fmtMetric(metric, hoveredColumn.aggA) : "—"} → B{" "}
                {hoveredColumn.aggB != null ? fmtMetric(metric, hoveredColumn.aggB) : "—"}
              </div>
              <div className="text-[10px] text-muted-foreground/60">click for detail</div>
            </div>
          )}
        </>
      )}

      {/* pinned detail card */}
      {active && !active.isFolder && active.left && active.right && (
        <div className="mt-3 rounded-md border border-border bg-muted/20 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 truncate font-mono text-[13px] font-medium text-foreground">{active.label}</div>
            <button
              type="button"
              onClick={() => setPinnedKey(null)}
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
                { label: "checks", a: checksCell(active.left), b: checksCell(active.right) },
                {
                  label: "cost",
                  a: active.left.total_cost != null && active.left.total_cost > 0 ? formatCostMicro(active.left.total_cost) : "—",
                  b: active.right.total_cost != null && active.right.total_cost > 0 ? formatCostMicro(active.right.total_cost) : "—",
                },
                {
                  label: "duration",
                  a: fmtRunDuration(active.left),
                  b: fmtRunDuration(active.right),
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

      {active && active.isFolder && (
        <div className="mt-3 rounded-md border border-border bg-muted/20 px-4 py-2.5 text-[12px] text-muted-foreground">
          <span className="font-mono font-medium text-foreground">{active.label}</span> — folder aggregate over{" "}
          {active.taskCount} tasks: A {active.aggA != null ? fmtMetric(metric, active.aggA) : "—"} → B{" "}
          {active.aggB != null ? fmtMetric(metric, active.aggB) : "—"}.{" "}
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => toggleFolder(active.folder)}>
            Expand to tasks
          </button>
        </div>
      )}
    </div>
  );
}
