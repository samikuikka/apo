// PROTOTYPE · Variant D: the ambient flip pole. For each task with two or
// more runs in the window, its two most recent runs compared, per task, with
// no picking: regressions first, then newly errored, fixes, stable fails;
// tasks still passing collapse to one line. An errored side renders as
// error, never as failed. Throwaway (see NOTES.md).

import {
  formatDateTick,
  formatDateWithTime,
  type FlipKind,
  type FlipRunRef,
  type TaskFlip,
} from "./trends-data";

const GROUPS: { kind: FlipKind; title: string; hint: string; dot: string }[] = [
  { kind: "regression", title: "Got Worse", hint: "was passing, now failing", dot: "bg-destructive" },
  { kind: "new-error", title: "Errored", hint: "latest run gave no verdict", dot: "border border-destructive bg-muted" },
  { kind: "fix", title: "Got Fixed", hint: "was failing, now passing", dot: "bg-success" },
  { kind: "stable-fail", title: "Still Failing", hint: "failing in both runs", dot: "bg-destructive/40" },
];

export default function VariantDFlips({
  projectId,
  flips,
  windowSize,
}: {
  projectId: string;
  flips: TaskFlip[];
  windowSize: number;
}) {
  const count = (kind: FlipKind) => flips.filter((f) => f.kind === kind).length;
  const regressions = count("regression");
  const fixes = count("fix");
  const newErrors = count("new-error");
  const stableFail = count("stable-fail");
  const stablePass = count("stable-pass");

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-[18px] font-semibold tracking-tight">Run Trends</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          each task's latest run compared with the one before it · last{" "}
          {windowSize} runs · {flips.length} tasks ran at least twice
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          <span className="font-mono tabular-nums text-destructive">{regressions}</span>{" "}
          got worse ·{" "}
          <span className="font-mono tabular-nums">{newErrors}</span> errored ·{" "}
          <span className="font-mono tabular-nums text-success">{fixes}</span> got
          fixed ·{" "}
          <span className="font-mono tabular-nums">{stableFail}</span> still failing ·{" "}
          <span className="font-mono tabular-nums">{stablePass}</span> still passing
        </p>
      </header>

      {GROUPS.map((group) => {
        const rows = flips.filter((f) => f.kind === group.kind);
        if (rows.length === 0) return null;
        return (
          <section key={group.kind} className="border border-border bg-card">
            <h2 className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs font-semibold">
              <span className={`size-2 ${group.dot}`} aria-hidden />
              {group.title}
              <span className="font-mono tabular-nums text-muted-foreground">
                {rows.length}
              </span>
              <span className="font-normal text-muted-foreground">
                {group.hint}
              </span>
            </h2>
            {rows.map((flip) => (
              <FlipRow key={flip.taskId} projectId={projectId} flip={flip} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function FlipRow({
  projectId,
  flip,
}: {
  projectId: string;
  flip: TaskFlip;
}) {
  const modelChanged =
    flip.prev.model !== flip.next.model &&
    (flip.prev.model !== null || flip.next.model !== null);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 last:border-b-0">
      <span className="min-w-0 flex-1 truncate text-xs" title={flip.taskPath}>
        {flip.taskPath}
      </span>
      <FlipSide projectId={projectId} side={flip.prev} />
      <span aria-hidden className="font-mono text-xs text-muted-foreground">
        {"->"}
      </span>
      <FlipSide projectId={projectId} side={flip.next} />
      {modelChanged ? (
        <span
          className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground"
          title={`model changed: ${flip.prev.model ?? "unknown"} -> ${flip.next.model ?? "unknown"}`}
        >
          model changed
        </span>
      ) : null}
    </div>
  );
}

function FlipSide({ projectId, side }: { projectId: string; side: FlipRunRef }) {
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
    </a>
  );
}
