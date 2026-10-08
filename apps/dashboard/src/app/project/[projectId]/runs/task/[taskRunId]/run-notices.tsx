"use client";

import { useState } from "react";
import type { ModelDriftSummary } from "@/lib/agent-task-api";
import { formatCostMicro } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CorrectedCheckNotice } from "./run-notices-model";
import { driftedCalls, driftSeverity } from "./run-notices-model";

/**
 * Run-level notices (issue #410): everything that qualifies the verdict the
 * summary above just stated — corrected checks and model drift — shares one
 * treatment. A single strip of chips under the outcome summary; chip tone
 * carries severity; clicking a chip expands the full detail inline. The
 * strip owns the corrections rollup (the outcome summary's metadata does not
 * repeat it), and the expanded check carries only a pointer line — the
 * reason, actor, and timestamps live here.
 */
export function RunNotices({
  correctedChecks,
  drift: driftInput,
}: {
  correctedChecks: CorrectedCheckNotice[];
  /** The run's model_drift — absent on untraced / never-drifted runs. */
  drift: ModelDriftSummary | null | undefined;
}) {
  const [open, setOpen] = useState<"corrections" | "drift" | null>(null);
  const drift = driftInput ?? null;
  if (correctedChecks.length === 0 && !drift) return null;
  const driftOpen = open === "drift";
  const corrOpen = open === "corrections";
  // A correction always changes the verdict, so it is always material. Drift
  // is evidence about the verdict's validity — its loudness scales with how
  // much of the run actually ran on a fallback.
  const driftLoud = drift ? driftSeverity(drift) === "loud" : false;

  return (
    <div className="border-t border-border bg-muted/20 px-6 py-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        {correctedChecks.length > 0 && (
          <button
            type="button"
            aria-expanded={corrOpen}
            onClick={() => setOpen(corrOpen ? null : "corrections")}
            className="inline-flex items-center gap-1.5 border border-warning/40 bg-warning/10 px-2 py-0.5 text-warning transition-colors hover:bg-warning/20"
          >
            ⚑ {correctedChecks.length} check{correctedChecks.length === 1 ? "" : "s"} corrected
            <span className="text-warning/60">{corrOpen ? "▾" : "▸"}</span>
          </button>
        )}
        {drift && (
          <button
            type="button"
            aria-expanded={driftOpen}
            onClick={() => setOpen(driftOpen ? null : "drift")}
            className={cn(
              "inline-flex items-center gap-1.5 border px-2 py-0.5 transition-colors",
              driftLoud
                ? "border-warning/40 bg-warning/10 text-warning hover:bg-warning/20"
                : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
            )}
          >
            ⚑ model drift — {driftedCalls(drift)}/{drift.total_agent_generations} gens
            <span className="opacity-60">{driftOpen ? "▾" : "▸"}</span>
          </button>
        )}
        <span className="ml-auto text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
          run notices
        </span>
      </div>

      {corrOpen && (
        <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
          {correctedChecks.map((check) => (
            <div key={check.id}>
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-[13px] text-foreground">{check.id}</span>
                <VerdictTransition recorded={check.recordedPass} effective={check.effectivePass} />
                <span className="text-muted-foreground">
                  by {check.byLabel} via {check.via.replace("_", " ")} ·{" "}
                  {new Date(check.createdAt).toLocaleString()}
                </span>
              </p>
              {check.reason && (
                <p className="mt-0.5 border-l-2 border-border pl-2.5 text-foreground/80">
                  {check.reason}
                </p>
              )}
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground">
            Recorded evidence is unchanged — corrections amend the verdict, not the run.
          </p>
        </div>
      )}

      {driftOpen && drift && (
        <div className="mt-2 border-t border-border/60 pt-2">
          <p className="text-foreground">
            {driftedCalls(drift)} of {drift.total_agent_generations} agent generations were
            served by a model other than{" "}
            <span className="font-mono">{drift.configured_model}</span>:
          </p>
          <ul className="mt-1 space-y-0.5 font-mono text-xs text-muted-foreground">
            {drift.pairs.map((pair) => (
              <li key={`${pair.model}/${pair.provider ?? "-"}/${pair.route ?? "-"}`}>
                {pair.model}
                {(pair.provider || pair.route) && (
                  <span className="text-muted-foreground/60">
                    {" "}via {pair.route || pair.provider}
                  </span>
                )}{" "}
                ×{pair.calls}
                {pair.cost_micro !== null && (
                  <span className="text-muted-foreground/60">
                    {" "}· {formatCostMicro(pair.cost_micro)}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 leading-relaxed text-muted-foreground">
            A serving gateway fell back mid-run, so the verdict is only partly evidence
            about the configured model. Cache hits are per model+provider, so calls
            after the switch re-billed their whole prompt as uncached input.
          </p>
        </div>
      )}
    </div>
  );
}

function VerdictTransition({ recorded, effective }: { recorded: boolean; effective: boolean }) {
  return (
    <span className="font-mono text-[11px]">
      <span className={recorded ? "text-success" : "text-destructive"}>
        {recorded ? "PASS" : "FAIL"}
      </span>
      <span className="mx-1 text-muted-foreground">→</span>
      <span className={effective ? "text-success" : "text-destructive"}>
        {effective ? "PASS" : "FAIL"}
      </span>
    </span>
  );
}
