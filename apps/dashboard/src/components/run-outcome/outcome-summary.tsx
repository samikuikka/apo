import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface OutcomeCounts {
  passed: number;
  failed: number;
  errored: number;
  total: number;
}

export interface OutcomeMetadataItem {
  icon?: LucideIcon;
  value: string;
  label?: string;
}

interface OutcomeSummaryProps {
  counts: OutcomeCounts;
  unit: "tasks" | "checks";
  running?: boolean;
  metadata?: OutcomeMetadataItem[];
}

function passRateTone(rate: number): string {
  if (rate >= 100) return "text-success";
  if (rate < 50) return "text-destructive";
  return "text-foreground";
}

function LegendCount({
  value,
  label,
  className,
}: {
  value: number;
  label: string;
  className?: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={cn("font-mono tabular-nums", className)}>{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

export function OutcomeSummary({
  counts,
  unit,
  running,
  metadata,
}: OutcomeSummaryProps) {
  const { passed, failed, errored, total } = counts;
  const rate = total > 0 ? Math.round((passed / total) * 100) : 0;
  // Don't show a pass rate until something has actually been evaluated —
  // a running batch with 0 results is not "0%", it's pending.
  const evaluated = passed + failed + errored;
  const showHero = evaluated > 0 || !running;

  return (
    <div className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:gap-5">
      <div className="flex shrink-0 flex-row items-baseline gap-2 sm:flex-col sm:items-start sm:gap-0">
        <span
          className={cn(
            "font-mono text-[32px] leading-none tabular-nums tracking-tight",
            showHero ? passRateTone(rate) : "text-muted-foreground",
          )}
        >
          {showHero ? `${rate}%` : "—"}
        </span>
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {showHero ? "pass rate" : running ? "running…" : "pass rate"}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <OutcomeBar counts={counts} running={running} />

        <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
          <LegendCount
            value={passed}
            label={`passed`}
            className={passed > 0 ? "text-success" : undefined}
          />
          <span className="text-muted-foreground/40">·</span>
          <LegendCount
            value={failed}
            label={`failed`}
            className={failed > 0 ? "text-destructive" : undefined}
          />
          {errored > 0 && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <LegendCount
                value={errored}
                label="errored"
                className="text-warning"
              />
            </>
          )}
          <span className="text-muted-foreground/40">·</span>
          <span className="inline-flex items-baseline gap-1">
            <span className="font-mono tabular-nums text-foreground">{total}</span>
            <span className="text-muted-foreground">{unit}</span>
          </span>
        </div>

        {metadata && metadata.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-muted-foreground">
            {metadata.map((item) => (
              <span key={`${item.label ?? ""}-${item.value}`} className="inline-flex items-center gap-1">
                {item.icon && <item.icon className="h-3 w-3 text-muted-foreground/50" />}
                <span className="font-mono tabular-nums text-foreground/80">
                  {item.value}
                </span>
                {item.label && (
                  <span className="text-muted-foreground">{item.label}</span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function OutcomeBar({
  counts,
  running,
}: {
  counts: OutcomeCounts;
  running?: boolean;
}) {
  const { passed, failed, errored, total } = counts;
  const hasSegments = total > 0;

  return (
    <div className="flex h-2 w-full max-w-md overflow-hidden rounded-full bg-border">
      {hasSegments && passed > 0 && (
        <div
          className="h-full bg-success"
          style={{ width: `${(passed / total) * 100}%` }}
        />
      )}
      {hasSegments && failed > 0 && (
        <div
          className="h-full bg-destructive"
          style={{ width: `${(failed / total) * 100}%` }}
        />
      )}
      {hasSegments && errored > 0 && (
        <div
          className="h-full bg-warning"
          style={{ width: `${(errored / total) * 100}%` }}
        />
      )}
      {running && (
        <div className="h-full animate-pulse bg-foreground/40" style={{ width: "12%" }} />
      )}
    </div>
  );
}
