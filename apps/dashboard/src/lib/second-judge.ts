import type { CheckResult, SecondJudgeEvidence } from "@/lib/agent-task-api";

/**
 * Second-judge facts — measurements, not diagnoses. A client-bundle-safe
 * local copy of the SDK's `secondJudgeFacts` / `secondJudgeTakeaway`
 * (`packages/sdk/src/agent-task/checks/second-judge.ts` is the single
 * source of truth — ``@apo-ai/sdk/agent-task`` is a server-runtime entry
 * that must never enter the browser bundle, so this module re-implements
 * the derivations instead of importing them).
 * ``__tests__/second-judge-drift.test.ts`` asserts behavior equality with
 * the SDK export so any divergence fails CI instead of forking the
 * language. Corroborated checks stay silent; a split shows both verdicts
 * plus the second judge's confidence; nothing claims *why* they differ.
 */

export type SecondJudgeFacts =
  | { kind: "none" } // no second judge ran (code/agentic check, or feature off)
  | { kind: "error" } // second opinion failed to arrive
  | { kind: "skipped" } // no verdict possible — the value exceeded the model's context
  | { kind: "split"; confidence: number } // verdicts differ — look closer
  | { kind: "agree"; confidence: number } // corroborated
  | { kind: "unsure"; confidence: number }; // agreed, but weakly (conf < 0.6)

export function secondJudgeFacts(check: CheckResult): SecondJudgeFacts {
  const sj = check.judge?.secondJudge;
  if (!sj) return { kind: "none" };
  if (sj.skipped) return { kind: "skipped" };
  if (sj.error || sj.choice == null) return { kind: "error" };
  const conf = sj.confidence ?? 0;
  if ((sj.choice === "pass") !== (check.pass === true)) {
    return { kind: "split", confidence: conf };
  }
  if (conf < 0.6) return { kind: "unsure", confidence: conf };
  return { kind: "agree", confidence: conf };
}

/** One honest sentence about the relation; null when corroborated. */
export function secondJudgeTakeaway(check: CheckResult): string | null {
  const facts = secondJudgeFacts(check);
  switch (facts.kind) {
    case "split":
      return `Verdicts differ — second judge contradicts at ${facts.confidence.toFixed(2)} confidence.`;
    case "unsure":
      return `Second judge unsure (${facts.confidence.toFixed(2)}) — weak corroboration.`;
    case "error":
      return `Second opinion failed to arrive${check.judge?.secondJudge?.error ? ` (${check.judge.secondJudge.error})` : ""}.`;
    case "skipped":
      return `Second opinion skipped${check.judge?.secondJudge?.skipped ? ` — ${check.judge.secondJudge.skipped}` : ""}.`;
    default:
      return null;
  }
}

/** The corroborated-agreement sentence shown inside the expand. */
export function secondJudgeAgreementLine(sj: SecondJudgeEvidence | undefined): string | null {
  if (!sj || sj.error || sj.skipped || sj.choice == null) return null;
  const conf = sj.confidence ?? 0;
  const projectionNote = sj.projected ? " (a projected value, not the full deliverable)" : "";
  return conf < 0.6
    ? `Second judge unsure (${conf.toFixed(2)}) — weak corroboration.`
    : `Verdicts agree — corroborated at ${conf.toFixed(2)}${projectionNote}.`;
}

export type SecondJudgeSummary = {
  corroborated: number;
  split: number;
  unsure: number;
  skipped: number;
};

/** Run-level tallies; all zero when no second judge ran at all. */
export function secondJudgeSummary(checks: CheckResult[]): SecondJudgeSummary {
  let corroborated = 0;
  let split = 0;
  let unsure = 0;
  let skipped = 0;
  for (const c of checks) {
    const f = secondJudgeFacts(c);
    if (f.kind === "split") split++;
    else if (f.kind === "unsure") unsure++;
    else if (f.kind === "agree") corroborated++;
    else if (f.kind === "skipped") skipped++;
  }
  return { corroborated, split, unsure, skipped };
}
