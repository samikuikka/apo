/**
 * Search-box token parsing: the Runs search box accepts structured filter
 * tokens alongside free text, so `customer:acme cost>0.50 timeout` becomes
 * a label filter, a cost range, and the text query "timeout". Tokens are
 * extracted on the debounced write, written to their URL params (the same
 * params the rail's checkboxes own), and the remaining text stays as `?q=`.
 * A token consumed from the search box is indistinguishable from one picked
 * in the sidebar; both write the same URL state.
 *
 * Grammar:
 * - `key:value` where key matches a known label dimension → label filter
 * - `env:name` or `environment:name` → environment filter
 * - `cost>N` / `cost>=N` / `cost<N` / `cost<=N` → cost range bound (dollars)
 * - `duration>N` / `duration>=N` / `duration<N` / `duration<=N` → duration
 *   range bound (seconds)
 * - Everything else → free text (the existing `?q=` search)
 */

import type { RunLabelFacets } from "@/lib/agent-task-api";
import type { RunMetricFilters } from "@/lib/run-metric-filters";
import type { RunScope } from "@/lib/run-scope";

export type SearchToken =
  | { kind: "label"; key: string; id: string }
  | { kind: "environment"; value: string }
  | { kind: "cost"; bound: "min" | "max"; value: number }
  | { kind: "duration"; bound: "min" | "max"; value: number };

export interface ParsedSearch {
  tokens: SearchToken[];
  /** The words that didn't match any token pattern, joined by space. */
  text: string;
}

const RANGE_RE = /^(cost|duration)\s*(>=|<=|>|<)\s*([\d.]+)$/;
const LABEL_RE = /^([A-Za-z0-9_-]{1,64}):(.+)$/;
const ENV_RE = /^(?:env|environment):(.+)$/i;

/**
 * Splits the input into structured tokens and free text. A word is only a
 * label token when its key matches a dimension the project's runs actually
 * carry (from the facets), so `customer:acme` filters when the project has a
 * customer dimension and stays free text otherwise. Range tokens (`cost>`,
 * `duration>`) and `env:` always parse; they need no facets to validate
 * against.
 */
export function parseSearchTokens(
  input: string,
  facets: RunLabelFacets | null,
): ParsedSearch {
  const knownKeys = new Set((facets?.labels ?? []).map((facet) => facet.key));
  const tokens: SearchToken[] = [];
  const words: string[] = [];

  for (const word of input.split(/\s+/).filter(Boolean)) {
    const rangeMatch = RANGE_RE.exec(word);
    if (rangeMatch) {
      const [, metric, operator, rawValue] = rangeMatch;
      const value = Number(rawValue);
      if (!Number.isFinite(value) || value < 0) {
        words.push(word);
        continue;
      }
      const isMin = operator === ">" || operator === ">=";
      tokens.push({
        kind: metric as "cost" | "duration",
        bound: isMin ? "min" : "max",
        value,
      });
      continue;
    }

    const envMatch = ENV_RE.exec(word);
    if (envMatch) {
      tokens.push({ kind: "environment", value: envMatch[1] });
      continue;
    }

    const labelMatch = LABEL_RE.exec(word);
    if (labelMatch && knownKeys.has(labelMatch[1])) {
      tokens.push({ kind: "label", key: labelMatch[1], id: labelMatch[2] });
      continue;
    }

    words.push(word);
  }

  return { tokens, text: words.join(" ") };
}

/**
 * Applies parsed tokens to the current scope and metric filters, returning
 * the next values. Label tokens OR into their key's selection (the same
 * semantics as the sidebar's checkboxes); range tokens set their bound.
 */
export function applyTokensToFilters(
  tokens: SearchToken[],
  scope: RunScope,
  metrics: RunMetricFilters,
): { scope: RunScope; metrics: RunMetricFilters; changed: boolean } {
  let nextScope: RunScope = scope;
  let nextMetrics = metrics;
  let changed = false;

  for (const token of tokens) {
    switch (token.kind) {
      case "label": {
        const current = nextScope.labels[token.key] ?? [];
        if (!current.includes(token.id)) {
          nextScope = {
            ...nextScope,
            labels: { ...nextScope.labels, [token.key]: [...current, token.id] },
          };
          changed = true;
        }
        break;
      }
      case "environment": {
        if (!nextScope.environments.includes(token.value)) {
          nextScope = {
            ...nextScope,
            environments: [...nextScope.environments, token.value],
          };
          changed = true;
        }
        break;
      }
      case "cost": {
        if (token.bound === "min" && nextMetrics.cost.min !== token.value) {
          nextMetrics = { ...nextMetrics, cost: { ...nextMetrics.cost, min: token.value } };
          changed = true;
        }
        if (token.bound === "max" && nextMetrics.cost.max !== token.value) {
          nextMetrics = { ...nextMetrics, cost: { ...nextMetrics.cost, max: token.value } };
          changed = true;
        }
        break;
      }
      case "duration": {
        const key = token.bound === "min" ? "min" : "max";
        if (nextMetrics.durationSeconds[key] !== token.value) {
          nextMetrics = {
            ...nextMetrics,
            durationSeconds: { ...nextMetrics.durationSeconds, [key]: token.value },
          };
          changed = true;
        }
        break;
      }
    }
  }

  return { scope: nextScope, metrics: nextMetrics, changed };
}

/** Autocomplete suggestions for the word currently being typed. */
export interface SearchSuggestion {
  /** The completed token to insert, e.g. "customer:acme" or "cost>0.50". */
  insert: string;
  /** What to show in the dropdown. */
  label: string;
  /** Optional count for label values. */
  count?: number;
}

/**
 * Suggests completions for the last word of the input, based on the facets'
 * dimensions and values. Returns empty when the word has no colon and no
 * recognized prefix (the user is just typing free text). A word that already
 * names a complete value is not re-suggested: completing what is fully typed
 * adds nothing.
 */
export function suggestTokens(
  input: string,
  facets: RunLabelFacets | null,
): SearchSuggestion[] {
  const lastWord = input.split(/\s+/).filter(Boolean).pop() ?? "";
  if (!lastWord) return [];

  const suggestions: SearchSuggestion[] = [];

  const labelMatch = LABEL_RE.exec(lastWord);
  if (labelMatch) {
    const [, key, partial] = labelMatch;
    const facet = (facets?.labels ?? []).find((f) => f.key === key);
    if (facet) {
      for (const value of facet.values) {
        const completes =
          value.id.toLowerCase().startsWith(partial.toLowerCase()) &&
          value.id.toLowerCase() !== partial.toLowerCase();
        if (completes) {
          suggestions.push({
            insert: `${key}:${value.id}`,
            label: `${key}:${value.name}`,
            count: value.count,
          });
        }
      }
      return suggestions.slice(0, 6);
    }
  }

  const envMatch = /^(?:env|environment):(.*)$/i.exec(lastWord);
  if (envMatch) {
    for (const bucket of facets?.environments ?? []) {
      const completes =
        bucket.value.toLowerCase().startsWith(envMatch[1].toLowerCase()) &&
        bucket.value.toLowerCase() !== envMatch[1].toLowerCase();
      if (completes) {
        suggestions.push({
          insert: `env:${bucket.value}`,
          label: `environment: ${bucket.value}`,
          count: bucket.count,
        });
      }
    }
    return suggestions.slice(0, 6);
  }

  const prefix = lastWord.toLowerCase();
  for (const facet of facets?.labels ?? []) {
    if (facet.key.toLowerCase().startsWith(prefix) && prefix.length >= 2) {
      for (const value of facet.values.slice(0, 3)) {
        suggestions.push({
          insert: `${facet.key}:${value.id}`,
          label: `${facet.key}:${value.name}`,
          count: value.count,
        });
      }
    }
  }

  return suggestions.slice(0, 6);
}
