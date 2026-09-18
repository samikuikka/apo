import type { TraceObservation } from "./contexts";

// Judge spans (judge:* / t.agent:*) form a distinct evaluation phase at the
// end of a trace. The tree collapses them into one Evaluation row so agent
// work stays readable when a suite carries many judgments (#302). Search is
// the escape hatch: while filtering, judge rows render like any other row.

/** A call is an evaluation root when its step name says so. */
export function isEvaluationRoot(name: string): boolean {
  return name.startsWith("judge:") || name.startsWith("t.agent:");
}

export interface EvaluationGroup {
  /** Root judge spans, in call order. */
  roots: TraceObservation[];
  /** Root ids plus every descendant span (their tool calls, sub-spans). */
  memberIds: Set<string>;
}

/** Collect the evaluation phase of a trace, or null when it has no judges. */
export function findEvaluationGroup(calls: TraceObservation[]): EvaluationGroup | null {
  const roots = calls.filter((c) => isEvaluationRoot(c.step_name ?? ""));
  if (roots.length === 0) return null;
  const memberIds = new Set(roots.map((c) => c.id));
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
  return { roots, memberIds };
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

/** Minimal flat-tree row shape — structural, so the tree component's row
 * type satisfies it without importing the component. */
export interface PartitionableRow {
  node: { id: string; call: TraceObservation | null };
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
