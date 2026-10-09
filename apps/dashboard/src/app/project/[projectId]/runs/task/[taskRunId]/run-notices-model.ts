/**
 * Pure model for the run notices strip (issue #410) — shared by the server
 * page (distills the run's corrected checks) and the client strip (drift
 * severity tiering). Kept free of "use client" so the server can call it.
 */
import type { ModelDriftSummary, TestResultCorrection } from "@/lib/agent-task-api";

/** One corrected check, distilled for the strip. */
export interface CorrectedCheckNotice {
  id: string;
  recordedPass: boolean;
  effectivePass: boolean;
  reason: string;
  byLabel: string;
  via: TestResultCorrection["corrected_via"];
  createdAt: string;
}

/** Agent generations served by a model other than the configured one. */
export function driftedCalls(drift: ModelDriftSummary): number {
  return drift.pairs.reduce((sum, pair) => sum + pair.calls, 0);
}

/** How loud the drift chip should be. Quiet when a small slice of calls
 * stayed on the exact same model (another host served it) — the fallback
 * barely changed the evidence. Loud when the fraction is material or the
 * fallback is a different model entirely. */
export function driftSeverity(drift: ModelDriftSummary): "quiet" | "loud" {
  const fraction = driftedCalls(drift) / Math.max(drift.total_agent_generations, 1);
  const sameModel = drift.pairs.every((pair) =>
    sameModelServedElsewhere(pair.model, drift.configured_model),
  );
  return fraction >= 0.05 || !sameModel ? "loud" : "quiet";
}

// Hosts that re-serve the exact same open-weight model under a suffixed id
// (Modal serves deepseek-v4.1-flash as deepseek-v4.1-flash-modal). A suffix
// that is not a known host (-lite, -mini, -preview) is a materially
// different model, not a reroute, and must stay loud — a prefix match would
// quietly excuse it.
const SAME_MODEL_HOST_SUFFIXES = ["-modal"];

function sameModelServedElsewhere(pairModel: string, configuredModel: string): boolean {
  const base = (name: string) => name.split("/").pop() ?? name;
  const pair = base(pairModel);
  const configured = base(configuredModel);
  return (
    pair === configured ||
    SAME_MODEL_HOST_SUFFIXES.some((suffix) => pair === `${configured}${suffix}`)
  );
}

/** Distill the run's corrected checks into strip notices. */
export function toCorrectedCheckNotices(
  checks: ReadonlyArray<{
    id?: string | number | null;
    pass?: boolean | null;
    recorded_pass?: boolean;
    correction?: TestResultCorrection | null;
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
      via: c.correction!.corrected_via,
      createdAt: c.correction!.created_at,
    }));
}
