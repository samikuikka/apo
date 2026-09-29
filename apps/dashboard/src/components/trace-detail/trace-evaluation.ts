import type { TraceObservation } from "./contexts";

// Judge spans (judge:* / t.agent:*) form a distinct evaluation phase at the
// end of a trace. The tree collapses them into one Evaluation row so agent
// work stays readable when a suite carries many judgments (#302). Search is
// the escape hatch: while filtering, judge rows render like any other row.
//
// The SDK groups the phase under a `checks.run` CHAIN span every judge nests
// under; when that span is present it anchors the group (and its summary
// carries the collapsed-row counts). Traces recorded before that emission —
// or by other producers — fall back to the judge:/t.agent: name prefix.

/** A call is an evaluation root when its step name says so. */
export function isEvaluationRoot(name: string): boolean {
  return name.startsWith("judge:") || name.startsWith("t.agent:");
}

export interface EvaluationGroup {
  /** The checks.run phase span, when the producer emitted one. */
  checksRun: TraceObservation | null;
  /** Root judge spans, in call order. */
  roots: TraceObservation[];
  /** Phase span + root ids plus every descendant span (their tool calls,
   * sub-spans). */
  memberIds: Set<string>;
}

/** Collect the evaluation phase of a trace, or null when it has neither a
 * checks.run span nor judge roots. */
export function findEvaluationGroup(calls: TraceObservation[]): EvaluationGroup | null {
  const roots = calls.filter((c) => isEvaluationRoot(c.step_name ?? ""));
  const checksRun =
    calls.find((c) => c.step_name === "checks.run") ?? null;
  if (roots.length === 0 && !checksRun) return null;
  const memberIds = new Set(roots.map((c) => c.id));
  if (checksRun) memberIds.add(checksRun.id);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of calls) {
      if (!memberIds.has(c.id) && c.parent_call_id && memberIds.has(c.parent_call_id)) {
        memberIds.add(c.id);
        grew = true;
      }
    }
  }
  return { checksRun, roots, memberIds };
}

// The verdict JSON ({"reasoning","pass"}) rides the span's tool_result, which
// slim trace payloads omit — the tree fetches full judge calls on demand and
// reads pass from that map.
export function parseVerdict(toolResult: unknown): boolean | undefined {
  const parsed = typeof toolResult === "string"
    ? (() => {
        try {
          return JSON.parse(toolResult) as unknown;
        } catch {
          return null;
        }
      })()
    : toolResult;
  const pass = (parsed as { pass?: unknown } | null)?.pass;
  return typeof pass === "boolean" ? pass : undefined;
}

/** Collapsed-row counts read from the checks.run span's tool_result. */
export interface PhaseSummary {
  total: number;
  passed: number;
  failed: number;
  /** Checks that ended without a verdict (judge errored / evidence
   * unsupported) — unknown quality, not failures (issue #323). */
  noVerdict: number;
}

/**
 * Parse the checks.run span's phase summary — the SDK's
 * `{total, passCount, failCount, noVerdictCount}` verdict payload — or null
 * when absent, malformed, or vacuous (total 0 carries no counts worth
 * showing). One fetch of the phase span replaces N per-judge fetches for
 * the collapsed row's counts.
 */
export function parsePhaseSummary(toolResult: unknown): PhaseSummary | null {
  const parsed = typeof toolResult === "string"
    ? (() => {
        try {
          return JSON.parse(toolResult) as unknown;
        } catch {
          return null;
        }
      })()
    : toolResult;
  const summary = parsed as
    | {
        total?: unknown;
        passCount?: unknown;
        failCount?: unknown;
        noVerdictCount?: unknown;
      }
    | null;
  if (
    typeof summary?.total !== "number" ||
    summary.total <= 0 ||
    typeof summary?.passCount !== "number" ||
    typeof summary?.failCount !== "number"
  ) {
    return null;
  }
  const noVerdict =
    typeof summary.noVerdictCount === "number" ? summary.noVerdictCount : 0;
  return {
    total: summary.total,
    passed: summary.passCount,
    failed: summary.failCount,
    noVerdict,
  };
}

/**
 * Whether the per-judge verdict fetches can be skipped right now: only while
 * no judgment row is visible (group collapsed AND no search surfacing them)
 * AND a checks.run summary is usable or still pending (one fetch in flight
 * beats N). Visible rows need their pass/fail badges; an unusable summary
 * (null) or a legacy trace (no span) must fall back to per-judge verdicts
 * for the counts.
 */
export function canSkipJudgeFetches(state: {
  checksRunId: string | null;
  judgmentsVisible: boolean;
  phaseSummary: PhaseSummary | null | undefined;
}): boolean {
  return (
    state.checksRunId !== null &&
    !state.judgmentsVisible &&
    state.phaseSummary !== null
  );
}

/**
 * Rows to render inside the expanded group: every member row except the
 * checks.run span's own — the group header already represents that span, so
 * rendering it again would duplicate the phase as a raw row.
 */
export function evaluationSubtreeRows<T extends PartitionableRow>(
  rows: T[],
  group: EvaluationGroup,
): T[] {
  const spanId = group.checksRun?.id ?? null;
  return rows.filter(
    (row) =>
      row.node.call !== null &&
      group.memberIds.has(row.node.call.id) &&
      row.node.call.id !== spanId,
  );
}

/** Minimal flat-tree row shape — structural, so the tree component's row
 * type satisfies it without importing the component. */
export interface PartitionableRow {
  node: { id: string; call: TraceObservation | null };
}

// ── Judgment facts ─────────────────────────────────────────────────────────
// The judgment brief (detail pane) shows what was judged, by what, and why
// it ruled — extracted from the full call payload, not raw JSON tabs.

export interface JudgmentFacts {
  /** Check name without the judge:/t.agent: prefix. */
  name: string;
  kind: "t.judge" | "t.agent";
  model?: string;
  instruction?: string;
  reasoning?: string;
  pass?: boolean;
  /** Direct child calls — a t.agent session's tool calls. */
  toolChildren: number;
  latencyMs?: number | null;
}

/**
 * Extract the judgment story from a judge/t.agent root call, or null for any
 * other call. The instruction and model ride the system message as
 * `{"model","instruction"}` JSON; the verdict ({"reasoning","pass"}) rides
 * tool_result.
 */
export function judgmentFacts(
  call: TraceObservation,
  allCalls: TraceObservation[],
): JudgmentFacts | null {
  const step = call.step_name ?? "";
  if (!isEvaluationRoot(step)) return null;
  const sys = (call.input as { messages?: Array<{ role: string; content: unknown }> } | null)
    ?.messages?.find((m) => m.role === "system")?.content;
  let model: string | undefined;
  let instruction: string | undefined;
  if (typeof sys === "string") {
    try {
      const parsed = JSON.parse(sys) as { model?: string; instruction?: string };
      model = parsed.model;
      instruction = parsed.instruction;
    } catch {
      // system prompt isn't the {model, instruction} JSON — leave undefined
    }
  }
  const verdict = call.tool_result as { pass?: boolean; reasoning?: string } | null;
  return {
    name: step.replace(/^(judge|t\.agent):/, ""),
    kind: step.startsWith("t.agent") ? "t.agent" : "t.judge",
    model,
    instruction,
    reasoning: verdict?.reasoning,
    pass: verdict?.pass,
    toolChildren: allCalls.filter((c) => c.parent_call_id === call.id).length,
    latencyMs: call.latency_ms,
  };
}

export interface EvaluationPartition<T extends PartitionableRow> {
  /** Rows outside the evaluation phase, original order. */
  kept: T[];
  /** Index into `kept` where the Evaluation row belongs: the position the
   * first judge row occupied in the unpartitioned tree. */
  insertAt: number;
}

/**
 * Split a flattened tree into agent-work rows and the evaluation phase.
 * Returns null when no member row is present (e.g. filters removed them).
 */
export function partitionEvaluation<T extends PartitionableRow>(
  rows: T[],
  group: EvaluationGroup,
): EvaluationPartition<T> | null {
  const isMember = (row: T) => row.node.call !== null && group.memberIds.has(row.node.call.id);
  const firstMember = rows.findIndex(isMember);
  if (firstMember === -1) return null;
  const kept = rows.filter((row) => !isMember(row));
  const insertAt = rows.slice(0, firstMember).filter((row) => !isMember(row)).length;
  return { kept, insertAt };
}
