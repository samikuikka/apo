"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCostMicro, usdFormat } from "@/lib/format";

/**
 * SPEC-136 ticket 11: dimension cost-breakdown tooltip.
 *
 * Reads the stored per-call cost breakdown directly (no client-side pricing
 * fetch). Groups dimensions by family (Input / Output), sorts by descending
 * cost, hides zero-cost rows, and surfaces unpriced dimensions in amber.
 * Provenance is a quiet footer ("computed" / "provided by SDK").
 */

export type CostProvenance = "provided" | "computed" | null;

/** Canonical dimension order within each family (matches the UsageKey enum). */
const INPUT_FAMILY = ["input", "cache_read", "cache_write_5m", "cache_write_1h"] as const;
const OUTPUT_FAMILY = ["output", "reasoning"] as const;

const DIMENSION_LABELS: Record<string, string> = {
  input: "Input",
  cache_read: "Cache read",
  cache_write_5m: "Cache write 5m",
  cache_write_1h: "Cache write 1h",
  output: "Output",
  reasoning: "Reasoning",
};

export interface CallBreakdownProps {
  children: React.ReactNode;
  breakdown?: Record<string, number> | null;
  rawUsage?: Record<string, number> | null;
  modelName?: string | null;
  provenance?: CostProvenance;
  cost?: number | null;
}

export interface RunBreakdownProps {
  children: React.ReactNode;
  calls: Array<{ model: string; cost?: number | null }>;
}

function isLegacyCall(
  breakdown: Record<string, number> | null | undefined,
  rawUsage: Record<string, number> | null | undefined,
  provenance: CostProvenance,
): boolean {
  // Pre-migration call: no breakdown, no raw_usage, no provenance flag.
  return (breakdown == null || Object.keys(breakdown).length === 0) && rawUsage == null && provenance == null;
}

interface DimensionRow {
  key: string;
  label: string;
  microUsd: number;
  unpriced: boolean;
}

/**
 * Build the sorted, zero-hidden rows for one family. Unpriced dimensions
 * (in raw_usage but not breakdown) surface as 0-cost amber rows.
 */
function familyRows(
  family: readonly string[],
  breakdown: Record<string, number> | null,
  rawUsage: Record<string, number> | null,
): DimensionRow[] {
  const rows: DimensionRow[] = [];
  for (const key of family) {
    const priced = breakdown?.[key];
    const usageCount = rawUsage?.[key];
    if (priced != null && priced > 0) {
      rows.push({ key, label: DIMENSION_LABELS[key] ?? key, microUsd: priced, unpriced: false });
    } else if (usageCount != null && usageCount > 0 && priced == null) {
      // In usage with a real count but unpriced -> amber (store-but-unpriced).
      rows.push({ key, label: DIMENSION_LABELS[key] ?? key, microUsd: 0, unpriced: true });
    }
    // A 0-token or 0-cost dimension is hidden entirely.
  }
  // Sort by descending cost; unpriced rows sink to the bottom of the family.
  return rows.sort((a, b) => b.microUsd - a.microUsd);
}

function unknownUnpricedRows(
  breakdown: Record<string, number> | null,
  rawUsage: Record<string, number> | null,
): DimensionRow[] {
  // Keys in raw_usage not in any family and unpriced (non-canonical pass-through).
  if (!rawUsage) return [];
  const known: Set<string> = new Set([...INPUT_FAMILY, ...OUTPUT_FAMILY]);
  const rows: DimensionRow[] = [];
  for (const key of Object.keys(rawUsage)) {
    if (known.has(key)) continue;
    if (breakdown?.[key] != null) continue;
    rows.push({ key, label: key, microUsd: 0, unpriced: true });
  }
  return rows;
}

export function CallCostBreakdownTooltip({
  children,
  breakdown,
  rawUsage,
  modelName,
  provenance,
  cost,
}: CallBreakdownProps) {
  const hasBreakdown = breakdown != null && Object.keys(breakdown).length > 0;
  const isLegacy = isLegacyCall(breakdown, rawUsage, provenance ?? null);

  // Render children as-is only when there is genuinely nothing to show
  // (no breakdown, no raw_usage, no provenance, no cost).
  if (!hasBreakdown && rawUsage == null && provenance == null && cost == null) {
    return <>{children}</>;
  }

  const inputRows = familyRows(INPUT_FAMILY, breakdown ?? null, rawUsage ?? null);
  const outputRows = familyRows(OUTPUT_FAMILY, breakdown ?? null, rawUsage ?? null);
  const unknownRows = unknownUnpricedRows(breakdown ?? null, rawUsage ?? null);
  const hasUnpriced = [...inputRows, ...outputRows, ...unknownRows].some((r) => r.unpriced);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        <div className="min-w-44 space-y-1">
          {modelName && modelName !== "unknown" && (
            <div className="font-medium">{modelName}</div>
          )}
          {/* Total above the rule. */}
          {cost != null && (
            <div className="font-mono tabular-nums">
              Total: {formatCostMicro(cost)}
            </div>
          )}
          {hasBreakdown && (
            <>
              <DimensionGroup label="Input" rows={inputRows} />
              <DimensionGroup label="Output" rows={outputRows} />
              {unknownRows.length > 0 && (
                <DimensionGroup label="Other" rows={unknownRows} />
              )}
            </>
          )}
          <div className="border-t border-border/40 pt-1 text-muted-foreground">
            {isLegacy
              ? "legacy call \u00b7 no breakdown stored (pre-migration)"
              : provenance === "provided"
                ? "provided by SDK \u00b7 no breakdown"
                : provenance === "computed"
                  ? `computed${hasUnpriced ? " \u00b7 \u26a0 unpriced dimensions" : ""}`
                  : null}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function DimensionGroup({ label, rows }: { label: string; rows: DimensionRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      {rows.map((row) => (
        <div
          key={row.key}
          className={`flex justify-between gap-3 font-mono tabular-nums ${row.unpriced ? "text-[var(--warning)]" : ""}`}
        >
          <span>
            {row.label}
            {row.unpriced && " \u26a0 unpriced"}
          </span>
          <span>{row.unpriced ? "\u2014" : usdFormat(row.microUsd / 1_000_000)}</span>
        </div>
      ))}
    </div>
  );
}

export function RunCostBreakdownTooltip({ children, calls }: RunBreakdownProps) {
  // Group calls by model, sum micro-USD cost.
  const byModel = new Map<string, { cost: number; count: number }>();
  for (const call of calls) {
    const entry = byModel.get(call.model) ?? { cost: 0, count: 0 };
    entry.cost += call.cost ?? 0;
    entry.count += 1;
    byModel.set(call.model, entry);
  }
  const entries = Array.from(byModel.entries()).filter(([, v]) => v.cost > 0);
  if (entries.length === 0) return <>{children}</>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        <div className="space-y-0.5">
          {entries.map(([model, v]) => (
            <div key={model} className="font-mono tabular-nums">
              <span className="font-medium">{model}</span>
              {`: ${formatCostMicro(v.cost)}`}
              {" "}
              ({v.count} call{v.count !== 1 ? "s" : ""})
            </div>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
