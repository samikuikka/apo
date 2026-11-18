// PROTOTYPE · Variant B: task-by-run flakiness grid over the last 40 batch
// runs. Cell fill carries state only (success = passed, destructive =
// failed, muted with destructive border = error); a quiet gray cell means
// the task did not run in that batch.

import {
  formatDateTick,
  gradedRate,
  shortModel,
  type TaskMatrixRow,
  type TrendPoint,
} from "./trends-data";

const HEADER_COL = 200;
const CELL = 12;
const GAP = 2;
const STRIP_H = 36;

export default function VariantBMatrix({
  projectId,
  columns,
  rows,
}: {
  projectId: string;
  columns: TrendPoint[];
  rows: TaskMatrixRow[];
}) {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-[18px] font-semibold tracking-tight">
          Run Trends
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          tasks x runs · last {columns.length} runs · newest right · ringed
          cell = status changed since that task's previous run
        </p>
      </header>

      <div className="overflow-x-auto border border-border bg-card">
        <div className="px-2 pt-2">
          <div
            className="flex items-end gap-[2px]"
            style={{ marginLeft: HEADER_COL + GAP }}
          >
          {columns.map((column) => {
            const rate = gradedRate(column);
            return (
              <div
                key={column.batchRunId}
                title={`${formatDateTick(column.createdAt)} · ${rate !== null ? `${column.passedChecks}/${column.totalChecks} checks` : "no completed checks"}`}
                className="shrink-0"
                style={{ width: CELL, height: STRIP_H }}
              >
                <div
                  className={rate !== null ? "bg-foreground/60" : "bg-destructive"}
                  style={{
                    height: rate !== null ? Math.max(1, rate * STRIP_H) : 3,
                    marginTop: rate !== null ? STRIP_H - rate * STRIP_H : STRIP_H - 3,
                  }}
                />
              </div>
            );
          })}
          </div>
        </div>

        <div
          className="mt-2 border-t border-border p-2"
          style={{
            display: "grid",
            gridTemplateColumns: `${HEADER_COL}px repeat(${columns.length}, ${CELL}px)`,
            gap: `${GAP}px`,
          }}
        >
          <div className="h-8" />
          {columns.map((column, i) => (
            <div key={column.batchRunId} className="relative h-8">
              {i % 10 === 0 || i === columns.length - 1 ? (
                <span className="absolute bottom-0 left-0 origin-bottom-left -rotate-[60deg] whitespace-nowrap text-[10px] text-muted-foreground">
                  {formatDateTick(column.createdAt)}
                </span>
              ) : null}
            </div>
          ))}

          {rows.map((row) => {
            const byIndex = new Map(row.cells.map((c) => [c.batchRunIndex, c]));
            return (
              <MatrixRow
                key={row.taskId}
                projectId={projectId}
                row={row}
                columns={columns}
                byIndex={byIndex}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MatrixRow({
  projectId,
  row,
  columns,
  byIndex,
}: {
  projectId: string;
  row: TaskMatrixRow;
  columns: TrendPoint[];
  byIndex: Map<number, { taskRunId: string; status: string; passedChecks: number; totalChecks: number; model: string | null }>;
}) {
  // Cells arrive sorted by batchRunIndex; a cell is "changed" when its status
  // differs from the task's previous run in the window (error counts as its
  // own status, so error transitions ring too).
  const changed = new Set<number>();
  let lastStatus: string | null = null;
  for (const cell of row.cells) {
    if (lastStatus !== null && cell.status !== lastStatus) {
      changed.add(cell.batchRunIndex);
    }
    lastStatus = cell.status;
  }
  return (
    <>
      <div className="flex min-w-0 items-baseline justify-between gap-2 pr-3">
        <span className="truncate text-xs" title={row.taskPath}>
          {row.taskPath}
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {row.passedCount}/{row.cells.length}
        </span>
      </div>
      {columns.map((column, i) => {
        const cell = byIndex.get(i);
        if (!cell) {
          return <div key={column.batchRunId} className="h-3 w-3 bg-muted/40" />;
        }
        const label = `${formatDateTick(column.createdAt)} · ${row.taskPath} · ${cell.status}${cell.model ? ` · ${shortModel(cell.model)}` : ""} · ${cell.passedChecks}/${cell.totalChecks} checks`;
        const fill =
          cell.status === "passed"
            ? "bg-success"
            : cell.status === "failed"
              ? "bg-destructive"
              : "border border-destructive bg-muted";
        return (
          <a
            key={column.batchRunId}
            href={`/project/${projectId}/runs/task/${cell.taskRunId}`}
            title={label}
            aria-label={label}
            className={`h-3 w-3 ${fill}${changed.has(i) ? " ring-1 ring-foreground" : ""}`}
          />
        );
      })}
    </>
  );
}
