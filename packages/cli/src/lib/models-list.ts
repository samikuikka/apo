/**
 * The model picker's data: the backend pricing catalog, mapped to
 * runnable-looking choices. The catalog keys models by anchored regex
 * patterns, so the "id" here is synthesized from the pattern — good
 * enough to populate OPENROUTER_MODEL with; a true runnable-models
 * endpoint would replace this mapping.
 */
import { apiGet } from "./api.ts";
import type { Config } from "./config.ts";

export type ModelOption = {
  /** A runnable-looking id synthesized from the pricing match_pattern. */
  id: string;
  display: string;
  provider: string;
  /** USD per 1M tokens, default tier. */
  input: number;
  output: number;
};

type WireTier = { is_default?: boolean; prices: { input?: number; output?: number } };
type WireModel = {
  match_pattern: string;
  provider: string;
  display_name: string;
  pricing_tiers: WireTier[];
};

/**
 * Fetch the effective model catalog for the configured project (globals
 * when no project). Returns an empty list — not an error — when the
 * backend is unreachable or no credentials exist; the picker then offers
 * only custom-id and keep-.env entries, with a notice.
 */
export async function fetchModelOptions(config: Config): Promise<ModelOption[]> {
  if (!config.apiKey) return [];
  const query = config.projectId
    ? `project=${encodeURIComponent(config.projectId)}&effective=true`
    : "effective=true";
  let docs: WireModel[];
  try {
    docs = await apiGet<WireModel[]>(config.backendUrl, `/api/v1/models?${query}`, undefined, config);
  } catch {
    return [];
  }
  const models = docs
    .map((m) => {
      const tier = m.pricing_tiers.find((t) => t.is_default) ?? m.pricing_tiers[0];
      return {
        id: idFromPattern(m.match_pattern),
        display: m.display_name,
        provider: m.provider === "generic" ? "other" : m.provider,
        input: tier?.prices.input ?? 0,
        output: tier?.prices.output ?? 0,
      };
    })
    .filter((m) => m.id !== "")
    // Date-tiered patterns share a display name; keep the first tier only.
    // The array is fresh from .map, so in-place sort is safe.
    .filter((m, i, arr) => arr.findIndex((x) => x.display === m.display) === i)
    .sort((a, b) => a.display.localeCompare(b.display));
  return models;
}

/** "(?i)^claude-sonnet-4[.-]5.*$" → "claude-sonnet-4-5". */
export function idFromPattern(pattern: string): string {
  return pattern
    .replace(/^\(\?i\)/, "")
    .replace(/^\^/, "")
    .replace(/\.\*\$$/, "")
    .replace(/\.\*$/, "")
    .replace(/\$$/, "")
    .replace(/\[\.-\]/g, "-")
    .replace(/\\/g, "");
}
