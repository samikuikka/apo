// PROTOTYPE · variant B, second round: the ambient pole. No new page; the
// entire suite-health surface is ONE column on the Tasks list ("Last Failed",
// the single metric that carries the whole verdict) plus one summary chip.
// Rows are a placeholder mock of the real Tasks table; the column is the idea.

import Link from "next/link";
import {
  MIN_GRADED,
  failingSinceLabel,
  formatDateTick,
  lastFailedLabel,
  type TaskHealth,
} from "./health-data";

function latestOutcome(task: TaskHealth): string {
  const last = task.runs[task.runs.length - 1];
  if (!last) return "not run";
  if (last.outcome === "passed") return "passing";
  if (last.outcome === "failed") return "failing";
  return "error";
}

/** The column's one value per task: last failure, or "failing since" for a
 * task currently stuck in a failure streak. Same metric, both directions. */
function lastFailedCell(task: TaskHealth): { text: string; tone: string } {
  if (task.failStreak >= 8 && task.graded >= MIN_GRADED) {
    return { text: failingSinceLabel(task), tone: "text-destructive" };
  }
  const never = task.failed === 0 && task.graded >= MIN_GRADED;
  return {
    text: task.graded < MIN_GRADED ? "n/a" : lastFailedLabel(task),
    tone: never ? "text-warning" : "text-muted-foreground",
  };
}

export default function VariantBTasksEmbed({
  projectId,
  tasks,
  demo,
}: {
  projectId: string;
  tasks: TaskHealth[];
  demo: boolean;
}) {
  const neverFailing = tasks.filter(
    (t) => t.graded >= MIN_GRADED && t.failed === 0,
  );
  const windowDays = neverFailing[0]?.windowDays ?? null;
  const rows = [
    ...neverFailing,
    ...tasks.filter((t) => t.graded >= MIN_GRADED && t.failStreak >= 8),
    ...tasks.filter((t) => t.graded >= MIN_GRADED && t.failed > 0 && t.failStreak < 8),
  ].slice(0, 9);

  const reviewHref = `/suite-health-prototype?health=A&project=${projectId}${demo ? "&data=demo" : ""}`;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <Link
        href={reviewHref}
        className="inline-flex items-baseline gap-2 border border-border bg-card px-3 py-2 font-mono text-xs tabular-nums hover:bg-accent"
      >
        <span className="text-warning">
          {neverFailing.length} tests never failed
        </span>
        {windowDays !== null && (
          <span className="text-muted-foreground">in the last {windowDays} days</span>
        )}
        <span className="text-muted-foreground">· review</span>
      </Link>

      <table className="mt-4 w-full text-xs">
        <thead>
          <tr className="border-b border-border text-left text-[10px] text-muted-foreground">
            <th className="py-1.5 pr-4 font-medium">Test</th>
            <th className="py-1.5 pr-4 font-medium">Status</th>
            <th className="py-1.5 pr-4 font-medium">Last Run</th>
            <th className="py-1.5 font-medium">Last Failed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((task) => {
            const cell = lastFailedCell(task);
            const last = task.runs[task.runs.length - 1];
            return (
              <tr key={task.taskId} className="border-b border-border/50">
                <td className="py-2 pr-4 font-mono">{task.displayName}</td>
                <td className="py-2 pr-4">{latestOutcome(task)}</td>
                <td className="py-2 pr-4 font-mono tabular-nums">
                  {last?.at ? formatDateTick(last.at) : "never"}
                </td>
                <td className={`py-2 font-mono tabular-nums ${cell.tone}`}>
                  {cell.text}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 text-[11px] text-muted-foreground">
        Placeholder rows standing in for the real Tasks table (folders,
        filters, and selection are not mocked). The one addition is the Last
        Failed column; the chip above is the only other new element.
      </p>
    </div>
  );
}
