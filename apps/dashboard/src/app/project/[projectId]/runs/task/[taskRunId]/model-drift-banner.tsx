import type { ModelDriftSummary } from "@/lib/agent-task-api";
import { formatCostMicro } from "@/lib/format";

/**
 * Model-integrity notice: part of the run was served by a model other than
 * the configured one (a gateway fallback — LiteLLM router, OpenRouter
 * provider/model fallback). Rendered only when the run actually drifted;
 * drift is evidence about the verdict's validity, not an error.
 */
export function ModelDriftBanner({ drift }: { drift: ModelDriftSummary }) {
  const driftedCalls = drift.pairs.reduce((sum, pair) => sum + pair.calls, 0);

  return (
    <div className="mx-6 mt-4 border border-warning/30 bg-warning/10 px-4 py-3 text-[13px] text-warning">
      <p className="font-medium">
        Model drift: {driftedCalls} of {drift.total_agent_generations} generations
        were served by a model other than the configured one.
      </p>
      <p className="mt-1 text-warning/80">
        A serving gateway fell back mid-run, so the verdict is only partly
        evidence about the configured model{" "}
        <span className="font-mono">{drift.configured_model}</span>. Cache hits
        are per model+provider, so calls after the switch re-billed their whole
        prompt as uncached input.
      </p>
      <ul className="mt-1.5 space-y-0.5 font-mono text-xs text-warning/80">
        {drift.pairs.map((pair) => (
          <li key={`${pair.model}/${pair.provider ?? "-"}/${pair.route ?? "-"}`}>
            {pair.model}
            {(pair.provider || pair.route) && (
              <span className="text-warning/60">
                {" "}
                via {pair.route || pair.provider}
              </span>
            )}{" "}
            ×{pair.calls}
            {pair.cost_micro !== null && (
              <span className="text-warning/60"> · {formatCostMicro(pair.cost_micro)}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
