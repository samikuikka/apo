// PROTOTYPE · Variant E: the explicit flip pole. Pick a baseline and a
// candidate batch run from the window (prev/next steppers, selection
// persists in ?base=/?cand=), then diff per task. Tasks present in both runs
// group by flip kind; "Only in baseline" / "Only in candidate" carry the
// rest, which with 1-task-per-batch data is most rows. Throwaway (see
// NOTES.md).

"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentTaskRunSummary } from "@/lib/agent-task-api";
import {
  buildRunDiff,
  formatDateTick,
  formatDateWithTime,
  formatPercent,
  gradedRate,
  kindFromStatuses,
  shortModel,
  type FlipKind,
  type FlipRunRef,
  type RunDiffEntry,
  type TrendPoint,
} from "./trends-data";

const GROUPS: { kind: FlipKind; title: string; dot: string }[] = [
  { kind: "regression", title: "Regressions", dot: "bg-destructive" },
  { kind: "new-error", title: "Newly Errored", dot: "border border-destructive bg-muted" },
  { kind: "fix", title: "Fixes", dot: "bg-success" },
  { kind: "stable-fail", title: "Stable Fails", dot: "bg-destructive/40" },
];

export default function VariantERunDiff({
  projectId,
  points,
  taskRuns,
  baseParam,
  candParam,
}: {
  projectId: string;
  points: TrendPoint[];
  taskRuns: AgentTaskRunSummary[];
  baseParam: string | undefined;
  candParam: string | undefined;
}) {
  const router = useRouter();
  const lastIndex = points.length - 1;
  const resolveIndex = (id: string | undefined, fallback: number) => {
    const found = id ? points.findIndex((p) => p.batchRunId === id) : -1;
    return found >= 0 ? found : fallback;
  };
  const baseIndex = resolveIndex(baseParam, Math.max(0, lastIndex - 10));
  const candIndex = resolveIndex(candParam, lastIndex);
  const diff = useMemo(
    () =>
      buildRunDiff(
        points,
        taskRuns,
        points[baseIndex].batchRunId,
        points[candIndex].batchRunId,
      ),
    [points, taskRuns, baseIndex, candIndex],
  );

  // Same replace-with-URL-params seam as the prototype switcher, so the
  // selection survives refreshes and shares.
  const step = (side: "base" | "cand", dir: 1 | -1) => {
    const current = side === "base" ? baseIndex : candIndex;
    const next = Math.min(lastIndex, Math.max(0, current + dir));
    const url = new URL(window.location.href);
    url.searchParams.set(side, points[next].batchRunId);
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  };

  const inBoth = diff.entries.filter(
    (entry): entry is RunDiffEntry & { base: FlipRunRef; cand: FlipRunRef } =>
      entry.base !== null && entry.cand !== null,
  );
  const onlyBase = diff.entries.filter(
    (entry): entry is RunDiffEntry & { base: FlipRunRef } =>
      entry.base !== null && entry.cand === null,
  );
  const onlyCand = diff.entries.filter(
    (entry): entry is RunDiffEntry & { cand: FlipRunRef } =>
      entry.base === null && entry.cand !== null,
  );
  const stablePass = inBoth.filter(
    (entry) => kindFromStatuses(entry.base.status, entry.cand.status) === "stable-pass",
  ).length;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-[18px] font-semibold tracking-tight">Run Trends</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          run diff · baseline vs candidate · window of {points.length} runs
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Step the arrows to pick two runs. Only tasks that ran in both runs
          can be compared; the rest land in the "only in" lists below.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <SidePanel
          label="Baseline"
          point={diff.base}
          index={baseIndex}
          total={points.length}
          onStep={(dir) => step("base", dir)}
        />
        <SidePanel
          label="Candidate"
          point={diff.cand}
          index={candIndex}
          total={points.length}
          onStep={(dir) => step("cand", dir)}
        />
      </div>

      {inBoth.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No tasks ran in both selected runs; every task sits in one side only.
        </p>
      ) : (
        GROUPS.map((group) => {
          const rows = inBoth.filter(
            (entry) => kindFromStatuses(entry.base.status, entry.cand.status) === group.kind,
          );
          if (rows.length === 0) return null;
          return (
            <section key={group.kind} className="border border-border bg-card">
              <h2 className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs font-semibold">
                <span className={`size-2 ${group.dot}`} aria-hidden />
                {group.title}
                <span className="font-mono tabular-nums text-muted-foreground">
                  {rows.length}
                </span>
              </h2>
              {rows.map((entry) => (
                <DiffRow key={entry.taskId} projectId={projectId} entry={entry} />
              ))}
            </section>
          );
        })
      )}
      {stablePass > 0 ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="size-2 bg-success" aria-hidden />
          {stablePass} tasks passing in both runs
        </p>
      ) : null}

      <OnlySection
        title="Only In Baseline"
        projectId={projectId}
        entries={onlyBase}
        pick={(entry) => entry.base}
      />
      <OnlySection
        title="Only In Candidate"
        projectId={projectId}
        entries={onlyCand}
        pick={(entry) => entry.cand}
      />
    </div>
  );
}

function SidePanel({
  label,
  point,
  index,
  total,
  onStep,
}: {
  label: string;
  point: TrendPoint;
  index: number;
  total: number;
  onStep: (dir: 1 | -1) => void;
}) {
  const rate = gradedRate(point);
  return (
    <section className="flex items-start justify-between gap-3 border border-border bg-card p-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">{label}</h2>
        <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
          {formatDateWithTime(point.createdAt)} · run {index + 1}/{total}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {rate !== null
            ? `${formatPercent(rate)} graded pass rate`
            : "no completed checks"}
          {point.models.length > 0
            ? ` · ${point.models.map(shortModel).join(", ")}`
            : ""}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-7"
          aria-label={`Step ${label.toLowerCase()} earlier`}
          disabled={index === 0}
          onClick={() => onStep(-1)}
        >
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-7"
          aria-label={`Step ${label.toLowerCase()} later`}
          disabled={index === total - 1}
          onClick={() => onStep(1)}
        >
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
    </section>
  );
}

function DiffRow({
  projectId,
  entry,
}: {
  projectId: string;
  entry: { taskId: string; taskPath: string; base: FlipRunRef; cand: FlipRunRef };
}) {
  const modelChanged =
    entry.base.model !== entry.cand.model &&
    (entry.base.model !== null || entry.cand.model !== null);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 last:border-b-0">
      <span className="min-w-0 flex-1 truncate text-xs" title={entry.taskPath}>
        {entry.taskPath}
      </span>
      <SideLink projectId={projectId} side={entry.base} />
      <span aria-hidden className="font-mono text-xs text-muted-foreground">
        {"->"}
      </span>
      <SideLink projectId={projectId} side={entry.cand} />
      {modelChanged ? (
        <span
          className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground"
          title={`model changed: ${entry.base.model ?? "unknown"} -> ${entry.cand.model ?? "unknown"}`}
        >
          model changed
        </span>
      ) : null}
    </div>
  );
}

function OnlySection<T extends { taskId: string; taskPath: string }>({
  title,
  projectId,
  entries,
  pick,
}: {
  title: string;
  projectId: string;
  entries: T[];
  pick: (entry: T) => FlipRunRef;
}) {
  if (entries.length === 0) return null;
  return (
    <section className="border border-border bg-card">
      <h2 className="border-b border-border px-4 py-2 text-xs font-semibold text-muted-foreground">
        {title}
        <span className="ml-2 font-mono tabular-nums">{entries.length}</span>
      </h2>
      {entries.map((entry) => (
        <div
          key={entry.taskId}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 last:border-b-0"
        >
          <span className="min-w-0 flex-1 truncate text-xs" title={entry.taskPath}>
            {entry.taskPath}
          </span>
          <SideLink projectId={projectId} side={pick(entry)} showModel />
        </div>
      ))}
    </section>
  );
}

function SideLink({
  projectId,
  side,
  showModel = false,
}: {
  projectId: string;
  side: FlipRunRef;
  showModel?: boolean;
}) {
  const label = `${formatDateWithTime(side.createdAt)} · ${side.status} · ${side.passedChecks}/${side.totalChecks} checks passed${side.model ? ` · ${side.model}` : ""}`;
  return (
    <a
      href={`/project/${projectId}/runs/task/${side.taskRunId}`}
      title={label}
      aria-label={label}
      className="flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums"
    >
      <span className="text-muted-foreground">{formatDateTick(side.createdAt)}</span>
      {side.status === "error" ? (
        <span className="border border-destructive px-1 text-muted-foreground">error</span>
      ) : (
        <span
          className={side.status === "passed" ? "text-success" : "text-destructive"}
        >
          {side.status === "passed" ? "pass" : "fail"} {side.passedChecks}/
          {side.totalChecks}
        </span>
      )}
      {showModel && side.model ? (
        <span className="text-muted-foreground">{shortModel(side.model)}</span>
      ) : null}
    </a>
  );
}
