/**
 * Run conclusion — the colored *verdict* of a batch/task run, derived from
 * outcome counts. Deliberately separate from lifecycle "status"
 * (queued/running/completed): a run that finished ("completed") but where
 * every task failed is NOT green. Green means *passed*, not *finished*.
 *
 * Modelled on GitHub Actions' status vs conclusion split.
 */

export type Conclusion =
  | "passed"
  | "failed"
  | "errored"
  | "running"
  | "queued";

export interface ConclusionStyle {
  label: string;
  dot: string;
  text: string;
}

export const CONCLUSION_STYLE: Record<Conclusion, ConclusionStyle> = {
  passed: { label: "Passed", dot: "bg-success", text: "text-success" },
  failed: { label: "Failed", dot: "bg-destructive", text: "text-destructive" },
  errored: { label: "Errored", dot: "bg-warning", text: "text-warning" },
  running: { label: "Running", dot: "bg-foreground animate-pulse", text: "text-muted-foreground" },
  queued: { label: "Queued", dot: "bg-muted-foreground/50", text: "text-muted-foreground" },
};

export interface ConclusionInput {
  status: string;
  passed: number;
  failed: number;
  errored: number;
  total: number;
}

export function deriveConclusion({
  status,
  passed,
  failed: _failed,
  errored,
  total,
}: ConclusionInput): Conclusion {
  if (status === "running") return "running";
  if (status === "queued") return "queued";
  // Finished (completed | failed | error). Binary verdict like GitHub
  // Actions: green only at 100%; the pass-rate number carries the nuance.
  if (total <= 0) return status === "error" ? "errored" : "queued";
  if (passed === total) return "passed";
  if (errored > 0) return "errored";
  return "failed";
}

export function conclusionStyle(input: ConclusionInput): ConclusionStyle {
  return CONCLUSION_STYLE[deriveConclusion(input)];
}
