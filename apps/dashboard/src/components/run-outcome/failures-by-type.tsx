import type { FailureBreakdownItem } from "@/lib/agent-task-api";
import { cn } from "@/lib/utils";

interface FailuresByTypeProps {
  breakdown: FailureBreakdownItem[];
  totalTasks: number;
}

const CATEGORY_DOT: Record<string, string> = {
  judge_failure: "bg-destructive",
  timeout: "bg-warning",
  trace_persistence: "bg-warning",
  execution: "bg-warning",
};

export function FailuresByType({ breakdown, totalTasks }: FailuresByTypeProps) {
  if (breakdown.length === 0) return null;

  const issueCount = breakdown.reduce((sum, item) => sum + item.count, 0);
  const maxCount = Math.max(...breakdown.map((item) => item.count), 1);

  return (
    <div className="mx-6 mt-4 border border-border bg-card px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Failures
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {issueCount} {issueCount === 1 ? "issue" : "issues"}
          {totalTasks > 0 && (
            <span className="text-muted-foreground/50"> of {totalTasks} {totalTasks === 1 ? "task" : "tasks"}</span>
          )}
        </span>
      </div>

      <div className="mt-2.5 flex flex-col gap-2">
        {breakdown.map((item) => {
          const dot = CATEGORY_DOT[item.category] ?? "bg-warning";
          const widthPct = (item.count / maxCount) * 100;
          return (
            <div key={item.category} className="flex items-center gap-2.5">
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
              <span className="w-36 shrink-0 truncate text-[13px] text-foreground/90">
                {item.label}
              </span>
              <span className="w-6 shrink-0 text-right font-mono text-[12px] tabular-nums text-foreground">
                {item.count}
              </span>
              <div className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-border">
                <div
                  className={cn("h-full", dot)}
                  style={{ width: `${widthPct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
