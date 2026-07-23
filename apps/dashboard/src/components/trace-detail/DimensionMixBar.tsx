"use client";

/**
 * SPEC-136 ticket 11: a 3px-tall monochrome bar showing a model's cost dimension
 * mix. Each canonical dimension is a grayscale shade (design.md: color = state,
 * not decoration); the relative width of a segment is that dimension's share of
 * the total breakdown. Amber is reserved for unpriced dimensions (none here —
 * the mix bar only shows priced dimensions from the stored breakdown).
 */

const DIMENSION_SHADES: Record<string, string> = {
  input: "oklch(0.85 0 0)",
  cache_read: "oklch(0.70 0 0)",
  cache_write_5m: "oklch(0.55 0 0)",
  cache_write_1h: "oklch(0.45 0 0)",
  output: "oklch(0.30 0 0)",
  reasoning: "oklch(0.20 0 0)",
};

const ORDER = ["input", "cache_read", "cache_write_5m", "cache_write_1h", "output", "reasoning"];

export interface DimensionMixBarProps {
  breakdown: Record<string, number>;
  className?: string;
}

export function DimensionMixBar({ breakdown, className }: DimensionMixBarProps) {
  const entries = ORDER.filter((k) => (breakdown[k] ?? 0) > 0).map((k) => ({
    key: k,
    value: breakdown[k],
  }));
  const total = entries.reduce((sum, e) => sum + e.value, 0);
  if (total <= 0) return null;

  return (
    <div className={`mt-1.5 flex h-[3px] w-full overflow-hidden ${className ?? ""}`} title="Cost dimension mix">
      {entries.map((e) => (
        <div
          key={e.key}
          style={{
            width: `${(e.value / total) * 100}%`,
            backgroundColor: DIMENSION_SHADES[e.key] ?? "oklch(0.5 0 0)",
          }}
        />
      ))}
    </div>
  );
}
