"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  fetchModelPricing,
  computeCallBreakdown,
  computeRunBreakdown,
  type CallCostBreakdown,
} from "@/lib/model-pricing";

interface CallBreakdownProps {
  children: React.ReactNode;
  call: {
    model: string;
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    cost?: number | null;
    provided_cost?: number | null;
    calculated_cost?: number | null;
  };
}

interface RunBreakdownProps {
  children: React.ReactNode;
  calls: Array<{
    model: string;
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    cost?: number | null;
  }>;
}

function formatUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

function formatPricePer1k(pricePer1m: number): string {
  const per1k = pricePer1m / 1_000;
  if (per1k >= 0.01) return `$${per1k.toFixed(2)}/1K`;
  return `$${per1k.toFixed(4)}/1K`;
}

function formatTokens(n: number): string {
  return n.toLocaleString();
}

function usePricingBreakdown(
  call: CallBreakdownProps["call"],
): CallCostBreakdown | null {
  const [breakdown, setBreakdown] = useState<CallCostBreakdown | null>(null);

  // Extract only the fields computeCallBreakdown reads, as a stable dependency
  // key so the effect re-fetches pricing only when these values actually change.
  const pricingKey = `${call.model}|${call.prompt_tokens}|${call.completion_tokens}|${call.cost}|${call.provided_cost}|${call.calculated_cost}`;

  useEffect(() => {
    let cancelled = false;
    fetchModelPricing()
      .then((pricing) => {
        if (!cancelled) {
          setBreakdown(computeCallBreakdown(call, pricing));
        }
      })
      .catch(() => {
        // Pricing unavailable — leave breakdown null; the tooltip falls back to
        // rendering children as-is (the hasBreakdown check below).
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pricingKey]); // call is captured but only pricingKey drives re-fetch

  return breakdown;
}

export function CallCostBreakdownTooltip({ children, call }: CallBreakdownProps) {
  const breakdown = usePricingBreakdown(call);

  const hasBreakdown =
    breakdown &&
    (breakdown.promptTokens != null || breakdown.completionTokens != null);

  if (!hasBreakdown) return <>{children}</>;

  const showPricing =
    breakdown.inputPricePer1M != null && breakdown.outputPricePer1M != null;
  const costsDiffer =
    breakdown.providedCost != null &&
    breakdown.calculatedCost != null &&
    Math.abs(breakdown.providedCost - breakdown.calculatedCost) > 0.0001;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        <div className="space-y-0.5">
          <div className="font-medium">{breakdown.model}</div>
          {breakdown.promptTokens != null && breakdown.promptTokens > 0 && (
            <div>
              Input: {formatTokens(breakdown.promptTokens)}
              {showPricing &&
                ` \u00d7 ${formatPricePer1k(breakdown.inputPricePer1M!)}`}
              {breakdown.promptCost != null &&
                ` = ${formatUsd(breakdown.promptCost)}`}
            </div>
          )}
          {breakdown.completionTokens != null &&
            breakdown.completionTokens > 0 && (
              <div>
                Output: {formatTokens(breakdown.completionTokens)}
                {showPricing &&
                  ` \u00d7 ${formatPricePer1k(breakdown.outputPricePer1M!)}`}
                {breakdown.completionCost != null &&
                  ` = ${formatUsd(breakdown.completionCost)}`}
              </div>
            )}
          <div className="border-t border-background/20 pt-0.5">
            Total:{" "}
            {breakdown.totalCost != null
              ? formatUsd(breakdown.totalCost)
              : "\u2014"}
          </div>
          {costsDiffer && (
            <div className="text-background/60">
              Provided: {formatUsd(breakdown.providedCost!)} &middot;
              Calculated: {formatUsd(breakdown.calculatedCost!)}
            </div>
          )}
          {!showPricing && (
            <div className="text-background/60">Pricing not configured</div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function RunCostBreakdownTooltip({ children, calls }: RunBreakdownProps) {
  const modelEntries = useMemo(
    () => computeRunBreakdown(calls),
    [calls],
  );

  if (modelEntries.length === 0) return <>{children}</>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        <div className="space-y-0.5">
          {modelEntries.map((entry) => (
            <div key={entry.model}>
              <span className="font-medium">{entry.model}</span>
              {entry.cost > 0 && `: ${formatUsd(entry.cost)}`}
              {" "}
({entry.callCount} call{entry.callCount !== 1 ? "s" : ""})
            </div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
