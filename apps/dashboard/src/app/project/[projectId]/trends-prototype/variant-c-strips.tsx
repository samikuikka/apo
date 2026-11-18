// PROTOTYPE · Variant C: the embed pole. A quiet three-panel strip that
// would sit above the Runs table, previewed here over static placeholder
// rows so the strip reads in context. No real data below the strip.

import { Sparkline } from "./chart-bits";
import {
  TREND_WINDOW,
  formatPercent,
  gradedRate,
  type TaskLatestResult,
  type TrendPoint,
} from "./trends-data";

const FAKE_ROWS = [
  { id: "5d04d023", bar: "w-24", tasks: "1/1", rate: "50%", ago: "2h ago" },
  { id: "3fa7c102", bar: "w-32", tasks: "1/1", rate: "83%", ago: "5h ago" },
  { id: "9b21e844", bar: "w-16", tasks: "0/1", rate: "0%", ago: "1d ago" },
  { id: "c47a6f19", bar: "w-28", tasks: "1/1", rate: "100%", ago: "1d ago" },
  { id: "e0d3b572", bar: "w-20", tasks: "1/1", rate: "83%", ago: "2d ago" },
];

export default function VariantCStrips({
  points,
  taskResults,
}: {
  points: TrendPoint[];
  taskResults: TaskLatestResult[];
}) {
  const rates = points.map(gradedRate);
  const lastRate = rates.at(-1) ?? null;
  const costs = points.map((p) => p.totalCost);
  const lastCost = [...costs].reverse().find((c) => c !== null) ?? null;
  const passing = taskResults.filter((t) => t.status === "passed").length;

  return (
    <div className="mx-auto max-w-6xl p-6">
      <h1 className="text-[18px] font-semibold tracking-tight">Runs</h1>

      <div className="mt-4 flex flex-wrap gap-2">
        <section className="min-w-[220px] flex-1 border border-border bg-card p-3">
          <p className="text-xs text-muted-foreground">
            Pass Rate · Last {Math.min(points.length, TREND_WINDOW)} Runs
          </p>
          <div className="mt-2 flex items-center gap-3">
            <Sparkline values={rates} width={160} height={36} max={1} />
            <span className="font-mono text-sm tabular-nums">
              {lastRate !== null ? formatPercent(lastRate) : "—"}
            </span>
          </div>
        </section>

        <section className="min-w-[220px] flex-1 border border-border bg-card p-3">
          <p className="text-xs text-muted-foreground">Cost</p>
          <div className="mt-2 flex items-center gap-3">
            {costs.some((c) => c !== null) ? (
              <>
                <Sparkline values={costs} width={160} height={36} />
                <span className="font-mono text-sm tabular-nums">
                  {lastCost !== null ? `$${lastCost.toFixed(2)}` : "—"}
                </span>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No cost data</p>
            )}
          </div>
        </section>

        <section className="min-w-[220px] flex-1 border border-border bg-card p-3">
          <p className="text-xs text-muted-foreground">Tasks Passing</p>
          <div className="mt-2 flex items-center gap-3">
            <span className="font-mono text-sm tabular-nums">
              {passing}/{taskResults.length}
            </span>
            <div className="flex flex-wrap gap-1">
              {taskResults.map((task) => (
                <span
                  key={task.taskId}
                  title={`${task.taskPath} · ${task.status}`}
                  className={
                    task.status === "passed"
                      ? "size-2 bg-success"
                      : "size-2 bg-destructive"
                  }
                />
              ))}
            </div>
          </div>
        </section>
      </div>

      <div className="mt-6 border border-border bg-card">
        <div className="grid grid-cols-[1fr_120px_90px_100px_80px] items-center gap-4 border-b border-border px-4 py-2 text-xs text-muted-foreground">
          <span>Run</span>
          <span>Execution</span>
          <span className="text-right">Tasks</span>
          <span className="text-right">Duration</span>
          <span className="text-right">Created</span>
        </div>
        {FAKE_ROWS.map((row) => (
          <div
            key={row.id}
            className="grid h-9 grid-cols-[1fr_120px_90px_100px_80px] items-center gap-4 border-b border-border px-4 last:border-b-0"
          >
            <div className="flex items-center gap-2">
              <span className="size-2 bg-muted" aria-hidden />
              <span className="font-mono text-xs text-muted-foreground">
                bch_{row.id}
              </span>
            </div>
            <div className={`h-2.5 ${row.bar} bg-muted/60`} aria-hidden />
            <span className="text-right font-mono text-xs tabular-nums text-muted-foreground">
              {row.tasks}
            </span>
            <span className="text-right font-mono text-xs tabular-nums text-muted-foreground">
              {row.rate}
            </span>
            <span className="text-right text-xs text-muted-foreground">
              {row.ago}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
