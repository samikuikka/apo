"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { ChevronRight, ExternalLink } from "lucide-react";

import {
  getAgentTaskRun,
  readTaskFile,
  type AgentTaskRunDetail,
  type AgentTaskRunSummary,
  type CheckAssertionResult,
  type CheckResult,
} from "@/lib/agent-task-api";
import { cn } from "@/lib/utils";
import { formatDuration, runDurationMs, usdFormat } from "@/lib/format";
import { extractJudgeReasoning } from "@/lib/judge-reasoning";
import { extractCheckBlock } from "@/lib/extract-check-block";
import { locateAssertionsInBlock } from "@/lib/locate-assertion";
import type { LineAssertion } from "./compare-markers";

const CompareCodeViewer = dynamic(
  () => import("./CompareCodeViewer").then((m) => m.CompareCodeViewer),
  { ssr: false },
);

import type { ComparisonTask } from "../use-comparison";

interface CompareTaskRowProps {
  task: ComparisonTask;
  expanded: Set<string>;
  onToggleExpand: (value: string, open?: boolean) => void;
  projectId: string;
}

/**
 * One task aligned across both runs: a left verdict cell and a right
 * verdict cell. Shows raw pass/fail with no directional claim. A
 * "not run" side is a muted em-dash, never a fail cell. Expanding a
 * differing task lazily loads both runs' checks and aligns them by
 * check id so the reader can see *which* check behaved differently.
 */
export function CompareTaskRow({
  task,
  expanded,
  onToggleExpand,
  projectId,
}: CompareTaskRowProps) {
  const isOpen = expanded.has(task.taskId);
  const { left, right, differs, expandable } = task;

  return (
    <div className="group/row">
      {/* Collapsed row: checks-only verdict cell per side. Cost/time live in
          the expand (TornadoMetrics) — the collapsed row's job is "did the
          runs disagree, and on which checks?", not "how much did it cost?".
          Fixed-width tracks so the count lands at the same x in every row. */}
      <div className="grid grid-cols-[1fr_auto] items-center gap-3 px-6 py-2.5 transition-colors hover:bg-muted/20 md:grid-cols-[minmax(0,1fr)_minmax(120px,1fr)_minmax(120px,1fr)]">
        {/* Task label + expand chevron. */}
        <div className="flex min-w-0 items-center gap-2.5">
          {expandable && (
            <button
              type="button"
              onClick={() => onToggleExpand(task.taskId)}
              aria-label={isOpen ? "Collapse checks" : "Expand checks"}
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-90")} />
            </button>
          )}
          <span
            className={cn(
              "truncate text-[13px] font-medium",
              differs ? "text-foreground" : "text-foreground/80",
            )}
          >
            {task.label}
          </span>
        </div>

        {/* Left checks cell. */}
        <ChecksCell run={left.run} />
        {/* Right checks cell — separate column at md+, wraps under on narrow.
            md:grid (not md:flex): the cell's internal layout IS a grid, and
            md:flex would override it, collapsing the bar slot. */}
        <ChecksCell run={right.run} className="hidden md:grid" />
      </div>

      {/* On narrow screens, stack the two cells so both are visible. */}
      <div className="grid grid-cols-2 gap-3 px-6 pb-2 md:hidden">
        <ChecksCell run={left.run} compact />
        <ChecksCell run={right.run} compact />
      </div>

      {isOpen && expandable && (
        <CheckDiff taskId={task.taskId} leftId={left.run?.id} rightId={right.run?.id} projectId={projectId} />
      )}
    </div>
  );
}

/** The checks-only verdict cell for the collapsed row. Shows HOW MUCH of the
 *  task passed as a mini bar + "7/8" count, colored by pass proportion — a
 *  task that passed 7/8 is very different from one that passed 2/8, and that
 *  difference is the whole point of comparing. Errored/running/no-checks runs
 *  fall back to a status dot. Cost/time are NOT here — they live in the
 *  expand (TornadoMetrics), where the A-vs-B comparison has room to breathe
 *  without crowding the collapsed row. */
function ChecksCell({
  run,
  className,
  compact,
}: {
  run: AgentTaskRunDetail | AgentTaskRunSummary | null;
  className?: string;
  compact?: boolean;
}) {
  if (!run) {
    return (
      <div className={cn("flex items-center gap-2 text-[12px] text-muted-foreground/40", className)}>
        <span className="h-2 w-2 rounded-full bg-muted-foreground/20" aria-hidden />
        <span className={cn("font-mono", compact ? "text-[11px]" : "text-[12px]")}>Not run</span>
      </div>
    );
  }

  const errored = run.status === "error";
  const running = run.status === "running" || run.status === "pending";
  const hasChecks = run.total_checks > 0;
  const passedChecks = run.passed_checks ?? 0;
  const checkRate = hasChecks ? Math.round((passedChecks / run.total_checks) * 100) : 0;

  // Bar color: the established tiering — green mostly-passing, red
  // mostly-failing, amber errored. A fact about proportion, not direction.
  const barColor = running
    ? "bg-foreground/40"
    : errored
      ? "bg-warning"
      : checkRate >= 80
        ? "bg-success"
        : checkRate < 50
          ? "bg-destructive"
          : "bg-foreground/30";

  return (
    <div
      className={cn(
        "grid items-center gap-2 text-[12px]",
        compact ? "grid-cols-[16px_32px]" : "grid-cols-[64px_28px]",
        className,
      )}
    >
      {hasChecks ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-border">
          <div className={cn("h-full", barColor)} style={{ width: `${checkRate}%` }} />
        </div>
      ) : (
        <span className={cn("h-2 w-2 justify-self-center rounded-full", barColor)} aria-hidden />
      )}
      <span
        className={cn(
          "justify-self-end font-mono tabular-nums",
          compact ? "text-[11px]" : "text-[12px]",
          running ? "text-muted-foreground" : errored ? "text-warning" : "text-muted-foreground",
        )}
      >
        {hasChecks ? `${passedChecks}/${run.total_checks}` : ""}
      </span>
    </div>
  );
}

function shortModel(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/** A compact mirrored (tornado) view of cost + time for the two runs, shown at
 *  the top of an expanded check row. Run A's bar grows left from the center
 *  axis, Run B's grows right. Symmetry reads as "same", asymmetry as
 *  "different" — the whole point of a comparison, made visual instead of
 *  forcing the reader to subtract two numbers.
 *
 *  Per-row scale: each side's fill = value / max(A,B), mapped to half the
 *  track width (each side owns 50%, so 100% fill on a side reaches the axis).
 *  Cross-row comparison is intentionally disabled — the page's job is A-vs-B
 *  within a row. A null value renders a muted empty slot (NOT zero), since
 *  "no cost recorded" is different from "$0" and a zero-fill on a scaled bar
 *  would misread as "free".
 *
 *  Bars are neutral (no winner coloring): a slower run might be doing more
 *  work, so "slower = bad" would moralize wrongly. Length carries the signal;
 *  color stays out of it. */
/** One metric row (cost or time) that drops into the SAME grid as the checks
 *  below — `[label · Run A cell · Run B cell]`. Sharing the grid means Run A's
 *  cost bar aligns directly under Run A's check column, so the eye scans one
 *  column instead of two unrelated layouts.
 *
 *  Each side is `[bar | value]`. Both bars share the same per-row scale
 *  (`value / max(A,B)`), so the larger side fills its track and the smaller
 *  side's shorter bar is the visual difference. Because the two bars sit in
 *  aligned columns with identical track widths, comparing their fill lengths
 *  is a single vertical eye movement — no tick or axis needed.
 *
 *  Null value → muted empty bar + "—" (no data), distinct from a true zero
 *  (which on a per-row-scaled bar would misread as "free/instant"). Bars are
 *  neutral — a slower run might be doing more work, so "slower = red" would
 *  moralize wrongly. Length carries the signal; color stays out of it. */
function MetricRow({
  label,
  leftValue,
  rightValue,
  formatLeft,
  formatRight,
}: {
  label: string;
  leftValue: number | null;
  rightValue: number | null;
  formatLeft: string;
  formatRight: string;
}) {
  const max = Math.max(leftValue ?? 0, rightValue ?? 0);
  return (
    <>
      {/* Label cell — sits in the same track as check names. */}
      <div className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <MetricSide
        value={leftValue}
        max={max}
        formatted={formatLeft}
        className="border-l border-border bg-muted/30"
      />
      <MetricSide
        value={rightValue}
        max={max}
        formatted={formatRight}
        className="border-l border-border bg-muted/30"
      />
    </>
  );
}

/** One side of a metric row: a bar + the formatted value. Drops into the
 *  shared grid as a single cell. */
function MetricSide({
  value,
  max,
  formatted,
  className,
}: {
  value: number | null;
  max: number;
  formatted: string;
  className?: string;
}) {
  const hasData = value != null;
  // Fill relative to the per-row max. A true zero renders as a hairline (2%)
  // so it's still visible; only null (no data) is an empty track.
  const pct = hasData && max > 0 ? (value / max) * 100 : 0;
  const width = value === 0 ? 2 : pct;
  return (
    <div className={cn("flex items-center gap-2.5 px-3 py-2", className)}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
        {hasData && (
          <div
            className="h-full rounded-full bg-foreground/40"
            style={{ width: `${width}%` }}
          />
        )}
      </div>
      <span
        className={cn(
          "w-16 shrink-0 text-right font-mono text-[11px] tabular-nums",
          hasData ? "text-foreground" : "text-muted-foreground/50",
        )}
      >
        {hasData ? formatted : "—"}
      </span>
    </div>
  );
}

/** The per-side result text for the reveal panel — built from the RUN's
 *  result, never the assertion's source text (which is already on the line).
 *
 *  Code vs judge differ in what's informative, so they branch (same isJudge
 *  condition as the runs page, task-run-detail-body.tsx:206):
 *
 *  - Code assertion: `received` is a scalar (e.g. `1`, `"ok"`, `false`). It's
 *    informative on BOTH pass and fail — "length < 2" with received `1` vs
 *    `0` is a real difference even when both passed. So always surface it,
 *    with `expected` when it differs. This is the datum not visible on the
 *    source line, and the one that differs between runs.
 *  - Judge assertion: `received` is the SUBMISSION being graded (often a
 *    large blob), never a differing scalar — echoing it is a category error.
 *    On fail, the reasoning IS the result (the judge's explanation). On pass,
 *    the reasoning is typically a stub ("passed") with no real content, so
 *    don't manufacture detail — the ✓ already says it passed.
 *  - No result: undefined (handled as notEvaluated / "Not recorded" upstream). */
function resultLabel(
  assertion: CheckAssertionResult | undefined,
  side: "Run A" | "Run B",
): string | undefined {
  if (!assertion) return undefined;

  const isJudge = Boolean(assertion.judge) || assertion.evaluator_type === "llm";

  // Code assertion: the received value is informative regardless of pass/fail.
  // "length < 2" passing with received 1 vs 0 is a real difference worth seeing.
  if (!isJudge && assertion.received !== undefined) {
    const received = formatValue(assertion.received);
    const expected =
      assertion.expected !== undefined && assertion.expected !== received
        ? assertion.expected
        : undefined;
    if (assertion.pass) {
      // Passed: the value met the bar. Still show it — "received 1" is real
      // information about how this run did, not just "passed".
      return expected
        ? `${side} · passed — received "${received}" (expected ${expected})`
        : `${side} · passed — received "${received}"`;
    }
    return expected
      ? `${side} · expected "${expected}", received "${received}"`
      : `${side} · received "${received}"`;
  }

  // Judge assertion: on fail, the reasoning is the result. Same extraction as
  // the runs page (task-run-detail-body.tsx:207) — try assertion.reasoning
  // first, then fall back to the judge metadata, where the real explanation
  // actually lives (the top-level field is usually a stub like "judge").
  if (isJudge && !assertion.pass) {
    const top = typeof assertion.reasoning === "string" ? assertion.reasoning.trim() : "";
    const reasoning =
      (top && !isStubReasoning(top) && top) ||
      (assertion.judge ? extractJudgeReasoning(assertion.judge) : undefined);
    if (reasoning) {
      const firstLine = reasoning.split("\n")[0];
      return `${side} · ${firstLine.slice(0, 150)}`;
    }
    return `${side} · Failed — no judge reasoning recorded`;
  }

  // Passed judge, or no received value on a code assertion: nothing
  // informative to add beyond the verdict. Returns undefined so the panel
  // shows the "Passed — no detail" empty state honestly.
  return undefined;
}

/** Serialize an assertion's `received` value for the tooltip. Strings as-is,
 *  objects/arrays as compact JSON, everything else via String(). Truncated so
 *  a huge response body can't produce a 50-line tooltip. */
function formatValue(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value && typeof value === "object") {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  } else {
    text = String(value);
  }
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}

/** The flow-runner writes these generic stubs as assertion reasoning. They
 *  carry no information, so suppress them and fall back to a plain "failed". */
function isStubReasoning(reasoning: string): boolean {
  const n = reasoning.toLowerCase().trim();
  return n === "passed" || n === "failed" || n === "judge";
}

/** The panel that appears below the code when a gutter marker is clicked.
 *  Shows both runs' results for that assertion line, side by side — the
 *  comparison's whole purpose. The clicked side is highlighted so the reader
 *  knows which marker they opened from; both are shown because the value of
 *  the comparison is seeing them adjacent.
 *
 *  Reuses `resultLabel` for the per-side text (same logic the old tooltip
 *  used): received value for code assertions, judge reasoning for judges. */
function RevealPanel({
  line,
  side,
  lineMap,
  onClose,
}: {
  line: number;
  side: "A" | "B";
  lineMap: Map<number, { left?: CheckAssertionResult; right?: CheckAssertionResult }>;
  onClose: () => void;
}) {
  const entry = lineMap.get(line);
  return (
    <div className="border-t border-border bg-card/40 px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Line {line}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-[12px] text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <RevealSide
          label="Run A"
          active={side === "A"}
          text={resultLabel(entry?.left, "Run A")}
          pass={entry?.left?.pass}
        />
        <RevealSide
          label="Run B"
          active={side === "B"}
          text={resultLabel(entry?.right, "Run B")}
          pass={entry?.right?.pass}
        />
      </div>
    </div>
  );
}

/** One side of the reveal panel. `active` highlights the side that was
 *  clicked; both sides are always shown so the comparison reads at a glance.
 *
 *  Text sizing follows design.md: body ≥12px for readability, muted-foreground
 *  (not /50 — that's below the established gray hierarchy and too faint). */
function RevealSide({
  label,
  active,
  text,
  pass,
}: {
  label: string;
  active: boolean;
  text: string | undefined;
  pass: boolean | undefined;
}) {
  return (
    <div className={cn("rounded border px-2 py-1.5", active ? "border-border bg-background" : "border-border/60")}>
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
        {pass !== undefined && (
          <span
            className={cn(
              "grid h-3.5 w-3.5 place-items-center rounded-full text-[9px]",
              pass ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive",
            )}
          >
            {pass ? "✓" : "✗"}
          </span>
        )}
      </div>
      {text ? (
        <p className="text-[12px] leading-relaxed text-foreground">{text.replace(/^Run [AB] · /, "")}</p>
      ) : (
        <p className="text-[12px] text-muted-foreground">
          {pass === undefined
            ? "Not recorded in this run."
            : pass
              ? "Passed — no further detail recorded."
              : "Failed — no detail recorded."}
        </p>
      )}
    </div>
  );
}

/** Aligned checks for a differing task — lazily loaded on expand. */
function CheckDiff({
  taskId,
  leftId,
  rightId,
  projectId,
}: {
  taskId: string;
  leftId: string | undefined;
  rightId: string | undefined;
  projectId: string;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; left: AgentTaskRunDetail | null; right: AgentTaskRunDetail | null }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    Promise.all([
      leftId ? getAgentTaskRun(leftId).catch(() => null) : Promise.resolve(null),
      rightId ? getAgentTaskRun(rightId).catch(() => null) : Promise.resolve(null),
    ]).then(([left, right]) => {
      if (cancelled) return;
      if (!left && !right) {
        setState({ status: "error", message: "Could not load check details for either run." });
        return;
      }
      setState({ status: "ready", left, right });
    });
    return () => {
      cancelled = true;
    };
  }, [taskId, leftId, rightId]);

  if (state.status === "loading") {
    return <div className="px-6 py-3 text-[12px] text-muted-foreground">Loading checks…</div>;
  }
  if (state.status === "error") {
    return <div className="px-6 py-3 text-[12px] text-destructive">{state.message}</div>;
  }

  const { left, right } = state;
  const leftChecks = left?.checks_json ?? [];
  const rightChecks = right?.checks_json ?? [];

  // Union of check ids, ordered by the left run's order then right-only.
  const leftOrder = new Map(leftChecks.map((c, i) => [c.id, i]));
  const ids = Array.from(new Set([...leftChecks.map((c) => c.id), ...rightChecks.map((c) => c.id)]));
  ids.sort((a, b) => {
    const ai = leftOrder.has(a) ? leftOrder.get(a)! : Number.MAX_SAFE_INTEGER;
    const bi = leftOrder.has(b) ? leftOrder.get(b)! : Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });

  const leftModel = left?.primary_model ? shortModel(left.primary_model) : null;
  const rightModel = right?.primary_model ? shortModel(right.primary_model) : null;
  const leftLabel = leftModel ? `Run A · ${leftModel}` : "Run A";
  const rightLabel = rightModel ? `Run B · ${rightModel}` : "Run B";
  // Commit SHA for source fetching — prefer the left run's, fall back to right.
  // The check definition should be the same across both runs of the same task.
  const commitSha = left?.task_source_commit_sha ?? right?.task_source_commit_sha ?? null;

  // Run-level metrics shown as rows in the same grid as the checks (below the
  // header, above the check rows). Null when a run didn't record the datum.
  const leftCost = left?.total_cost != null && left.total_cost > 0 ? left.total_cost : null;
  const rightCost = right?.total_cost != null && right.total_cost > 0 ? right.total_cost : null;
  const leftTime = runDurationMs(left?.started_at ?? null, left?.completed_at ?? null);
  const rightTime = runDurationMs(right?.started_at ?? null, right?.completed_at ?? null);
  const hasMetrics = (leftCost ?? rightCost) != null || (leftTime ?? rightTime) != null;

  // The grid is the single container for header + metrics + checks. Columns
  // are wide enough that cost/time values (e.g. "$0.0122") don't ellipsize —
  // minmax(180px,1fr) per side reserves room for the value slot. When there
  // are no checks but metrics exist, the grid still renders (header + metrics,
  // then a "No checks recorded" row).
  const hasContent = hasMetrics || ids.length > 0;

  return (
    <div className="border-t border-border/60 bg-muted/10 px-6 py-3">
      {hasContent ? (
        <div className="overflow-hidden rounded-md border border-border">
          {/* Column headers — explicit Run A / Run B so each cell reads in its
              column. Model is shown as run-level context for the checks. */}
          <div className="grid grid-cols-[minmax(120px,1fr)_minmax(180px,1fr)_minmax(180px,1fr)] border-b border-border bg-card/60 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <div className="px-3 py-1.5">Check</div>
            <div className="border-l border-border px-3 py-1.5">
              {left ? (
                <Link
                  href={`/project/${projectId}/runs/task/${left.id}`}
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                >
                  {leftLabel} <ExternalLink className="h-3 w-3" />
                </Link>
              ) : (
                leftLabel
              )}
            </div>
            <div className="border-l border-border px-3 py-1.5">
              {right ? (
                <Link
                  href={`/project/${projectId}/runs/task/${right.id}`}
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                >
                  {rightLabel} <ExternalLink className="h-3 w-3" />
                </Link>
              ) : (
                rightLabel
              )}
            </div>
          </div>

          {/* Run-level metric rows (cost/time). Same grid as the checks →
              Run A's cost bar aligns under Run A's check column. Skipped when
              neither side recorded either metric. The shared per-row scale
              means the larger side fills its bar; the shorter bar IS the
              difference, no tick needed (the bars sit in aligned columns). */}
          {hasMetrics && (
            <div className="grid grid-cols-[minmax(120px,1fr)_minmax(180px,1fr)_minmax(180px,1fr)] border-b border-border bg-muted/20">
              {(leftCost != null || rightCost != null) && (
                <MetricRow
                  label="cost"
                  leftValue={leftCost}
                  rightValue={rightCost}
                  formatLeft={leftCost != null ? usdFormat(leftCost) : "—"}
                  formatRight={rightCost != null ? usdFormat(rightCost) : "—"}
                />
              )}
              {(leftTime != null || rightTime != null) && (
                <MetricRow
                  label="time"
                  leftValue={leftTime}
                  rightValue={rightTime}
                  formatLeft={leftTime != null ? formatDuration(leftTime) : "—"}
                  formatRight={rightTime != null ? formatDuration(rightTime) : "—"}
                />
              )}
            </div>
          )}

          {ids.length === 0 ? (
            <div className="grid grid-cols-[minmax(120px,1fr)_minmax(180px,1fr)_minmax(180px,1fr)] px-3 py-2 text-[12px] text-muted-foreground">
              No checks recorded.
            </div>
          ) : (
            ids.map((id) => {
              const lc = leftChecks.find((c) => c.id === id);
              const rc = rightChecks.find((c) => c.id === id);
              const bothPresent = Boolean(lc && rc);
              const flipped = bothPresent && lc!.pass !== rc!.pass;
              // A check is inspectable whenever it exists on at least one side —
              // not only when both sides flipped. A check present in only one run
              // is itself a difference worth expanding (to see its reasoning).
              const inspectable = Boolean(lc || rc);
              return (
                <CheckRow
                  key={id}
                  id={id}
                  left={lc}
                  right={rc}
                  flipped={flipped}
                  inspectable={inspectable}
                  taskId={taskId}
                  projectId={projectId}
                  commitSha={commitSha}
                />
              );
            })
          )}
        </div>
      ) : (
        <div className="text-[12px] text-muted-foreground">No checks recorded.</div>
      )}
    </div>
  );
}

/** One check row: name + Run A ✓/✗ + Run B ✓/✗. Expanding an inspectable
 *  check shows its source with both runs' assertion results inline — where,
 *  within the check, the two runs diverged. A check is inspectable whenever
 *  it exists on at least one side — a symmetric flip, but also a check
 *  present in only one run (itself a difference). Non-inspectable checks
 *  (neither side has the check) don't render a row at all. The judge's prose
 *  reasoning is deliberately not shown here; it lives on the individual run
 *  page, one click away via the Run A / Run B header links. */
function CheckRow({
  id,
  left,
  right,
  flipped,
  inspectable,
  taskId,
  projectId,
  commitSha,
}: {
  id: string;
  left: CheckResult | undefined;
  right: CheckResult | undefined;
  flipped: boolean;
  inspectable: boolean;
  taskId: string;
  projectId: string;
  commitSha: string | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = left ?? right;
  return (
    <div className={cn("border-b border-border/60 last:border-b-0", flipped && "bg-foreground/[0.03]")}>
      <div className="grid grid-cols-[minmax(120px,1fr)_1fr_1fr] items-center">
        <div className="flex min-w-0 items-center gap-2 px-3 py-2">
          {inspectable && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-label={open ? "Collapse" : "Expand"}
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
            </button>
          )}
          <span className="truncate font-mono text-[12px] text-foreground/90">{id}</span>
        </div>
        {/* Collapsed verdict cells are bare ✓/✗ badges. The first-line
            reasoning that used to sit next to a ✗ was noise in a comparison:
            tall when many checks failed, and for multi-judge checks the
            reasoning picker (checkReasoning) showed only one of several
            explanations anyway. The "where did it fail" signal lives in the
            expanded source view; the "why" lives on the run page. */}
        <div className="flex min-w-0 items-center gap-2 border-l border-border px-3 py-2">
          <CheckBadge check={left} />
        </div>
        <div className="flex min-w-0 items-center gap-2 border-l border-border px-3 py-2">
          <CheckBadge check={right} />
        </div>
      </div>

      {/* The check's source with both runs' assertion results inline — the one
          thing the comparison can show that the individual run page can't:
          where, within the check, Run A and Run B diverged. The judge's prose
          reasoning is intentionally absent here; it lives on the run page (the
          Run A / Run B header links), one click away. */}
      {inspectable && open && ref && (
        <div className="border-t border-border/40 px-3 py-2">
          <CheckSourceWithResults
            checkId={id}
            sourceFile={ref.source_file}
            taskId={taskId}
            projectId={projectId}
            commitSha={commitSha}
            leftCheck={left}
            rightCheck={right}
          />
        </div>
      )}
    </div>
  );
}

/** The verdict explanation for one side — *why* it passed or failed. This is
 *  the single thing the comparison shows that the individual run page can't:
 *  the two reasonings side by side. Everything else (criterion, test source,
 *  judge prompt/response) lives on the individual run page, reached via the
 *  Run A / Run B header links — no duplication here.
 *
 *  ── Removed (option C): the prose reasoning panel and the inline first-line
 *  of reasoning in the collapsed row. In a comparison the tall, multi-judge
 *  reasoning was noise — the source view below shows where runs diverge; the
 *  judge's "why" lives on the run page. The reasoning-picker helpers
 *  (checkReasoning / isGenericStub) were deleted with it. Reach it via the
 *  Run A / Run B links in the check header. */

/** The check's source code with both runs' assertion results shown as gutter
 *  markers on the lines they test. The code IS the structure — no separate
 *  table, no floating source block. Each assertion line carries Run A's and
 *  Run B's ✓/✗ marker in a dedicated gutter, so you see WHERE each run
 *  passed/failed within the check, right on the code that defines it.
 *
 *  The full source is shown — the reader already chose to inspect this check
 *  by expanding its row, so no second preview-then-expand step. Clicking a
 *  marker reveals that run's result (received value / judge reasoning) in a
 *  panel below the code. Fetches automatically when the check row is opened. */
function CheckSourceWithResults({
  checkId,
  sourceFile,
  taskId,
  projectId,
  commitSha,
  leftCheck,
  rightCheck,
}: {
  checkId: string;
  sourceFile: string | undefined;
  taskId: string;
  projectId: string;
  commitSha: string | null;
  leftCheck: CheckResult | undefined;
  rightCheck: CheckResult | undefined;
}) {
  // Which assertion's result the reader clicked to reveal (line + side). Null
  // when nothing is revealed. Lives in this component (not the viewer) so the
  // viewer stays a controlled component — it reports clicks, the parent owns
  // the reveal state and renders the panel. Cleared implicitly when the check
  // row collapses (this component unmounts).
  const [revealed, setRevealed] = useState<{ line: number; side: "A" | "B" } | null>(null);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; code: string; language: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const candidates = sourceFile
      ? [sourceFile, `${taskId}.eval.ts`]
      : [`${taskId}.eval.ts`, "task.ts", "checks.ts"];

    (async () => {
      let lastError: unknown;
      for (const candidate of candidates) {
        try {
          let source: { content: string; language: string };
          try {
            source = await readTaskFile(
              taskId, candidate, undefined, projectId,
              commitSha ?? undefined, controller.signal,
            );
          } catch {
            source = await readTaskFile(
              taskId, candidate, undefined, undefined,
              undefined, controller.signal,
            );
          }
          const block = extractCheckBlock(source.content, { id: checkId });
          if (block || candidates.length === 1) {
            if (cancelled) return;
            setState({
              status: "ready",
              code: block?.code ?? source.content,
              language: source.language ?? "typescript",
            });
            return;
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          lastError = error;
        }
      }
      if (!cancelled) {
        setState({
          status: "error",
          message: lastError instanceof Error ? lastError.message : "Could not load check source.",
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [checkId, sourceFile, taskId, projectId, commitSha]);

  // Locate each run's assertions onto lines of the source block. Builds a
  // map: line number → { left?, right? } assertion results. Empty when the
  // source isn't loaded yet — hooks must run unconditionally (Rules of Hooks),
  // so the early returns for loading/error come AFTER all useMemo calls.
  const lineMap = useMemo(() => {
    if (state.status !== "ready") return new Map<number, { left?: CheckAssertionResult; right?: CheckAssertionResult }>();
    const map = new Map<number, { left?: CheckAssertionResult; right?: CheckAssertionResult }>();
    const place = (check: CheckResult | undefined, side: "left" | "right") => {
      if (!check?.assertions || check.assertions.length === 0) return;
      const lines = locateAssertionsInBlock(
        state.code,
        check.assertions.map((a) => ({ id: a.id })),
      );
      check.assertions.forEach((a, i) => {
        const line = lines[i];
        if (line === undefined) return;
        const entry = map.get(line) ?? {};
        entry[side] = a;
        map.set(line, entry);
      });
    };
    place(leftCheck, "left");
    place(rightCheck, "right");

    // Also detect `t.<method>(` lines that have NO recorded assertion — these
    // are assertions that never ran (e.g. the check short-circuited after an
    // earlier failure). Without this, those lines look broken/empty. We mark
    // them so the viewer can show a muted "not evaluated" indicator.
    const tCallRe = /(^|[^.\w])((await\s+)?)t\.\w+\s*\(/;
    const srcLines = state.code.split("\n");
    for (let i = 0; i < srcLines.length; i++) {
      const lineNo = i + 1;
      if (tCallRe.test(srcLines[i]) && !map.has(lineNo)) {
        map.set(lineNo, {}); // empty entry = "not evaluated" on either side
      }
    }
    return map;
  }, [state, leftCheck, rightCheck]);

  // Convert the line map into the array shape the CodeMirror viewer wants.
  // `notEvaluated` is true when the line has a `t.*` call but no recorded
  // result on either side — the assertion exists but never ran (short-circuit).
  // Per-side labels are built from each RUN's RESULT (received value), not
  // the assertion's `expected` text — the source line already shows `expected`,
  // so a tooltip repeating it is useless. The received value is the one datum
  // not visible on the line, and it's what differs between runs.
  const lineAssertions: LineAssertion[] = useMemo(() => {
    const result: LineAssertion[] = [];
    for (const [line, entry] of lineMap) {
      const notEvaluated = !entry.left && !entry.right;
      result.push({
        line,
        left: entry.left?.pass,
        right: entry.right?.pass,
        leftLabel: resultLabel(entry.left, "Run A"),
        rightLabel: resultLabel(entry.right, "Run B"),
        notEvaluated,
      });
    }
    return result;
  }, [lineMap]);

  // Early returns come AFTER all hooks — see Rules of Hooks.
  if (state.status === "loading") {
    return <p className="text-[11px] text-muted-foreground/50">Loading check source…</p>;
  }
  if (state.status === "error") {
    return <p className="text-[11px] text-muted-foreground/50">{state.message}</p>;
  }

  // The reader already chose to inspect this check by expanding its row — no
  // second preview-then-expand step. Show the full source with all markers.
  // (Previously this clipped to a 7-line preview with a fade-to-expand, which
  // was friction inherited from when the source shared space with a prose
  // reasoning panel. With the panel gone, the preview is just an extra click.)
  return (
    <div className="rounded border border-border">
      <CompareCodeViewer
        code={state.code}
        language={state.language}
        assertions={lineAssertions}
        onMarkerClick={(line, side) =>
          setRevealed((prev) => (prev?.line === line && prev?.side === side ? null : { line, side }))
        }
      />
      {revealed && <RevealPanel line={revealed.line} side={revealed.side} lineMap={lineMap} onClose={() => setRevealed(null)} />}
    </div>
  );
}

/** Pass/fail badge for one side of an aligned check row. Reuses the
 *  established /15 alpha-tinted circle vocabulary. A missing check (run
 *  didn't record it) is a muted dash, not a fail. */
function CheckBadge({ check }: { check: CheckResult | undefined }) {
  if (!check) {
    return (
      <span className="flex w-5 justify-end font-mono text-[12px] text-muted-foreground/40">—</span>
    );
  }
  const passed = check.pass;
  return (
    <span
      className={cn(
        "grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px]",
        passed ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive",
      )}
      aria-label={passed ? "Passed" : "Failed"}
    >
      {passed ? "✓" : "✗"}
    </span>
  );
}
