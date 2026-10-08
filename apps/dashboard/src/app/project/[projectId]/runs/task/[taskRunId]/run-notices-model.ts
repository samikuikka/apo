/**
 * Pure model for the run notices strip (issue #410) — shared by the server
 * page (distills the run's corrected checks) and the client strip (drift
 * severity tiering). Kept free of "use client" so the server can call it.
 */
import type { ModelDriftSummary } from "@/lib/agent-task-api";

/** One corrected check, distilled for the strip. */
export interface CorrectedCheckNotice {
  id: string;
  recordedPass: boolean;
  effectivePass: boolean;
  reason: string;
  byLabel: string;
  via: string;
  createdAt: string;
}

/** Agent generations served by a model other than the configured one. */
export function driftedCalls(drift: ModelDriftSummary): number {
  return drift.pairs.reduce((sum, pair) => sum + pair.calls, 0);
}

/** How loud the drift chip should be. Quiet when a small slice of calls
 * stayed on the same model family (another host) — the fallback barely
 * changed the evidence. Loud when the fraction is material or the fallback
 * is a different model entirely. */
export function driftSeverity(drift: ModelDriftSummary): "quiet" | "loud" {
  const fraction = driftedCalls(drift) / Math.max(drift.total_agent_generations, 1);
  const sameFamily = drift.pairs.every((pair) => {
    const base = (name: string) => name.split("/").pop() ?? name;
    return base(pair.model).startsWith(base(drift.configured_model));
  });
  return fraction >= 0.05 || !sameFamily ? "loud" : "quiet";
}

/** Distill the run's corrected checks into strip notices. */
export function toCorrectedCheckNotices(
  checks: ReadonlyArray<{
    id?: string | number | null;
    pass?: boolean | null;
    recorded_pass?: boolean;
    correction?: {
      reason: string;
      corrected_by_label: string | null;
      corrected_by_user_id: string | null;
      corrected_via: string;
      created_at: string;
    } | null;
  }>,
): CorrectedCheckNotice[] {
  return checks
    .filter((c) => c.correction != null && c.recorded_pass !== undefined)
    .map((c) => ({
      id: String(c.id ?? ""),
      recordedPass: c.recorded_pass === true,
      effectivePass: c.pass === true,
      reason: c.correction?.reason ?? "",
      byLabel:
        c.correction?.corrected_by_label ??
        c.correction?.corrected_by_user_id ??
        "unknown",
      via: c.correction?.corrected_via ?? "session",
      createdAt: c.correction?.created_at ?? "",
    }));
}
