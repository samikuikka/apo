"use client";

import { useMemo } from "react";
import type { PrototypeTaskV2 } from "./data-v2";
import { describeConfig, emptyBaseline, provisionalFallback, scheduleBaseline } from "./data-v2";
import { EmptyBaseline, EvidenceLine, RunStrip, TaskIdentityV2, WarningChip } from "./shared";

/**
 * Model A — Schedule-anchored baseline.
 *
 * Each Task's primary schedule defines its current evidence. Manual and CI
 * runs do not move the baseline; they appear in Trends as evidence. Tasks
 * without a schedule fall back to a clearly-marked "provisional: latest
 * manual run" so the page is still useful when scheduling is not set up.
 */
export function ScheduleVariant({ tasks }: { tasks: PrototypeTaskV2[] }) {
  const rows = useMemo(
    () =>
      tasks.map((task) => {
        if (task.schedule) {
          const baseline = scheduleBaseline(task);
          // A schedule exists but never fired — surface that explicitly so
          // users do not mistake "no baseline" for "broken".
          if (baseline.runs.length === 0) {
            const provisional = provisionalFallback(task);
            return { task, kind: "schedule_pending" as const, baseline, provisional };
          }
          // Detect mixed-config across ALL scheduled runs of the schedule,
          // not just the trailing cohort. A schedule that drifted between
          // models is a real signal even when the most recent run is clean.
          const scheduledRuns = task.runs.filter(
            (r) => r.trigger === "schedule" && r.scheduleName === task.schedule!.name,
          );
          const seenConfigs = new Set(scheduledRuns.map((r) => `${r.config.model}:${r.config.effort}`));
          const mixedConfigs = seenConfigs.size > 1;
          const driftedFromDeclared =
            scheduledRuns.some((r) => r.config.model !== task.schedule!.config.model || r.config.effort !== task.schedule!.config.effort);
          return { task, kind: "scheduled" as const, baseline, mixedConfigs, driftedFromDeclared };
        }
        if (task.runs.length === 0) {
          return { task, kind: "never_run" as const, baseline: emptyBaseline() };
        }
        const provisional = provisionalFallback(task);
        return { task, kind: "no_schedule" as const, baseline: provisional, provisional };
      }),
    [tasks],
  );

  const summary = useMemo(() => {
    let healthy = 0;
    let needsAttention = 0;
    let provisional = 0;
    let neverRun = 0;
    for (const row of rows) {
      if (row.kind === "never_run") neverRun += 1;
      else if (row.kind !== "scheduled") provisional += 1;
      else {
        const rate = row.baseline.passRate ?? 0;
        if (row.baseline.errors > 0 || rate < 80) needsAttention += 1;
        else healthy += 1;
      }
    }
    return { healthy, needsAttention, provisional, neverRun };
  }, [rows]);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4 px-6 pb-4 pt-5">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">Current health, schedule-anchored baseline</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Each Task's primary schedule defines what counts as current. Manual and CI runs are evidence in Trends,
            not in the baseline.
          </p>
        </div>
        <div className="flex items-center gap-5 text-xs">
          <Count value={summary.healthy} label="Healthy" tone="success" />
          <Count value={summary.needsAttention} label="Needs attention" tone="destructive" />
          <Count value={summary.provisional} label="Provisional" tone="warning" />
          <Count value={summary.neverRun} label="Never run" tone="muted" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-y border-border bg-card/30 px-6 py-3 text-xs">
        <span className="font-semibold">Baseline rule</span>
        <span className="text-muted-foreground">
          Latest run from each Task's primary schedule.{" "}
          <span className="text-foreground/70">Scheduled = canonical; manual & CI = evidence.</span>
        </span>
      </div>

      <div className="px-6 py-5">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="pb-2 font-normal">Task</th>
              <th className="pb-2 font-normal">Schedule</th>
              <th className="pb-2 font-normal">Baseline</th>
              <th className="pb-2 font-normal">Cohort vs history</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ScheduleRow key={row.task.id} row={row} />
            ))}
          </tbody>
        </table>

        <div className="mt-5 rounded-sm border border-border/60 bg-card/20 px-4 py-3 text-[11px] text-muted-foreground">
          <strong className="text-foreground/80">Reading this view:</strong> a Task with a healthy schedule shows one
          number — its current scheduled baseline. Tasks without a schedule show a{" "}
          <WarningChip tone="warning">Provisional</WarningChip> pill: we use the most recent run so the page isn't
          empty, but that run might be a one-off experiment. Fix it by attaching a schedule.
        </div>
      </div>
    </div>
  );
}

type ScheduleRowEntry =
  | { task: PrototypeTaskV2; kind: "scheduled"; baseline: ReturnType<typeof scheduleBaseline>; mixedConfigs: boolean; driftedFromDeclared: boolean }
  | { task: PrototypeTaskV2; kind: "schedule_pending"; baseline: ReturnType<typeof emptyBaseline>; provisional: ReturnType<typeof provisionalFallback> }
  | { task: PrototypeTaskV2; kind: "no_schedule"; baseline: ReturnType<typeof provisionalFallback>; provisional: ReturnType<typeof provisionalFallback> }
  | { task: PrototypeTaskV2; kind: "never_run"; baseline: ReturnType<typeof emptyBaseline> };

function ScheduleRow({ row }: { row: ScheduleRowEntry }) {
  const { task, kind } = row;

  return (
    <tr className={`border-b border-border/70 align-top ${kind === "never_run" || kind === "schedule_pending" ? "bg-card/20" : ""}`}>
      <td className="py-3 pr-5">
        <TaskIdentityV2 name={task.name} folder={task.folder} tag={task.tag} />
        {kind === "scheduled" && task.schedule && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="font-mono">{task.schedule.name}</span>
            <span aria-hidden>·</span>
            <span>{describeConfig(task.schedule.config)}</span>
          </div>
        )}
        {kind === "schedule_pending" && task.schedule && (
          <div className="mt-1.5 text-[10px] text-warning">
            Schedule configured (<span className="font-mono">{task.schedule.name}</span>) but never fired.
          </div>
        )}
        {kind === "no_schedule" && (
          <div className="mt-1.5 text-[10px] text-muted-foreground">No schedule attached.</div>
        )}
        {kind === "never_run" && (
          <div className="mt-1.5 text-[10px] text-muted-foreground/70">No runs. No schedule.</div>
        )}
      </td>

      <td className="py-3 pr-5">
        {task.schedule ? (
          <div className="text-xs">
            <div className="font-medium text-foreground/80">{task.schedule.cadence}</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              last: <span className="font-mono">{shortDate(task.schedule.lastTriggeredAt)}</span>
            </div>
            <div className="text-[10px] text-muted-foreground">
              next: <span className="font-mono">{shortDate(task.schedule.nextRunAt)}</span>
            </div>
          </div>
        ) : (
          <span className="text-[10px] text-muted-foreground/60">—</span>
        )}
      </td>

      <td className="py-3 pr-5">
        {kind === "scheduled" && row.baseline.runs.length > 0 && (
          <div>
            <BaselineNumber baseline={row.baseline} />
            <EvidenceLine run={row.baseline.runs[row.baseline.runs.length - 1]} count={row.baseline.runs.length} />
            {row.driftedFromDeclared && (
              <div className="mt-1.5">
                <WarningChip tone="warning">Schedule drifted from declared config</WarningChip>
              </div>
            )}
            {!row.driftedFromDeclared && row.mixedConfigs && (
              <div className="mt-1.5">
                <WarningChip tone="warning">Mixed config in schedule</WarningChip>
              </div>
            )}
          </div>
        )}
        {kind === "schedule_pending" && row.provisional.latest && (
          <div>
            <div className="flex items-center gap-1.5">
              <ProvisionalNumber baseline={row.provisional} />
            </div>
            <div className="mt-1">
              <WarningChip tone="warning">Provisional · CI run</WarningChip>
            </div>
            <EvidenceLine run={row.provisional.latest} showTrigger={false} />
          </div>
        )}
        {kind === "no_schedule" && row.provisional.latest && (
          <div>
            <ProvisionalNumber baseline={row.provisional} />
            <div className="mt-1">
              <WarningChip tone="warning">Provisional · no schedule</WarningChip>
            </div>
            <EvidenceLine run={row.provisional.latest} />
          </div>
        )}
        {kind === "never_run" && <EmptyBaseline reason="This Task has never run." />}
      </td>

      <td className="py-3 pr-5">
        {kind === "scheduled" ? (
          <>
            <RunStrip
              runs={task.runs}
              counted={(r) => r.trigger === "schedule" && r.scheduleName === task.schedule!.name}
            />
            <div className="mt-1.5 text-[10px] text-muted-foreground">
              {row.baseline.runs.length} scheduled of {task.runs.length} total · manual & CI dimmed
            </div>
          </>
        ) : kind === "schedule_pending" || kind === "no_schedule" ? (
          <>
            <RunStrip runs={task.runs} counted={(r) => r.id === row.provisional.latest!.id} />
            <div className="mt-1.5 text-[10px] text-muted-foreground">Latest run highlighted · no scheduled cohort</div>
          </>
        ) : (
          <span className="text-[10px] text-muted-foreground/60">no history</span>
        )}
      </td>
    </tr>
  );
}

function BaselineNumber({ baseline }: { baseline: ReturnType<typeof scheduleBaseline> }) {
  const rate = baseline.passRate;
  if (rate === null) {
    return (
      <div className="text-xs text-warning">
        Execution error
        <div className="mt-0.5 text-[10px] text-muted-foreground">No verdict</div>
      </div>
    );
  }
  const tone = rate >= 80 ? "text-success" : rate < 50 ? "text-destructive" : "text-warning";
  return (
    <div>
      <div className={`font-mono text-[18px] font-semibold tabular-nums ${tone}`}>{rate}%</div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">
        {baseline.passedChecks}/{baseline.totalChecks} checks · {baseline.checkRate}% pass
      </div>
    </div>
  );
}

function ProvisionalNumber({ baseline }: { baseline: ReturnType<typeof provisionalFallback> }) {
  const rate = baseline.passRate;
  if (rate === null) return <span className="text-xs text-warning">Execution error</span>;
  const tone = rate >= 80 ? "text-success" : rate < 50 ? "text-destructive" : "text-warning";
  return (
    <div>
      <div className={`font-mono text-[18px] font-semibold tabular-nums opacity-70 ${tone}`}>{rate}%</div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">single run</div>
    </div>
  );
}

function Count({ value, label, tone }: { value: number; label: string; tone: "success" | "destructive" | "warning" | "muted" }) {
  const cls = tone === "success" ? "text-success" : tone === "destructive" ? "text-destructive" : tone === "warning" ? "text-warning" : "text-muted-foreground";
  return (
    <span>
      <span className={`mr-1.5 font-mono font-semibold ${cls}`}>{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function shortDate(iso: string): string {
  // Match the prototype's terse aesthetic: "Jul 21".
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
