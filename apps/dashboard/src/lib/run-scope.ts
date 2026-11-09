/**
 * The run scope: which environments and labels a run list is narrowed to.
 *
 * The URL uses the API's own encoding, so a page forwards it unchanged:
 * `?environment=prod,staging` (comma-joined, OR'd) and a repeated
 * `?label=<key>:<id>` (OR within a key, AND across keys). Labels match on
 * their stable id; the facets supply each id's display name.
 */

import type { FilterBarFacet } from "@/components/filter-bar";
import type { RunLabelFacets } from "@/lib/agent-task-api";
import type { SearchParamQuery } from "@/lib/run-cohort";

export interface RunScope {
  environments: string[];
  /** label key → OR'd ids */
  labels: Record<string, string[]>;
}

export const EMPTY_RUN_SCOPE: RunScope = { environments: [], labels: {} };

type ParamSource = SearchParamQuery | URLSearchParams;

function allValues(source: ParamSource, key: string): string[] {
  if (source instanceof URLSearchParams) return source.getAll(key);
  const value = source[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Read the scope from page search params (server) or `useSearchParams` (client). */
export function parseRunScope(source: ParamSource): RunScope {
  const environments = [
    ...new Set(
      allValues(source, "environment").flatMap((raw) =>
        raw.split(",").map((part) => part.trim()).filter(Boolean),
      ),
    ),
  ];
  const labels: Record<string, string[]> = {};
  for (const raw of allValues(source, "label")) {
    const at = raw.indexOf(":");
    if (at <= 0 || at === raw.length - 1) continue; // malformed: the API would refuse it
    const key = raw.slice(0, at);
    const id = raw.slice(at + 1);
    const ids = (labels[key] ??= []);
    if (!ids.includes(id)) ids.push(id);
  }
  return { environments, labels };
}

export function isRunScopeActive(scope: RunScope): boolean {
  return scope.environments.length > 0 || Object.values(scope.labels).some((ids) => ids.length > 0);
}

/** The `label` values of the scope, in the API's `<key>:<id>` encoding. */
export function runScopeLabelParams(scope: RunScope): string[] {
  return Object.entries(scope.labels).flatMap(([key, ids]) => ids.map((id) => `${key}:${id}`));
}

/** The scope as list-API query options (`listAgentTaskBatchRuns`, `listTaskRuns`). */
export function runScopeQuery(scope: RunScope): { environment?: string[]; label?: string[] } {
  const label = runScopeLabelParams(scope);
  return {
    environment: scope.environments.length > 0 ? scope.environments : undefined,
    label: label.length > 0 ? label : undefined,
  };
}

/** Replace the scope's params in `params`. */
export function writeRunScope(params: URLSearchParams, scope: RunScope): void {
  params.delete("environment");
  params.delete("label");
  if (scope.environments.length > 0) params.set("environment", scope.environments.join(","));
  for (const value of runScopeLabelParams(scope)) params.append("label", value);
}

// Several ids arrive only through a link; the picker shows them as one option
// so the filter stays visible and clearable.
const SEVERAL_VALUE = "__several__";

function pickerOf(
  key: string,
  label: string,
  known: { value: string; label: string }[],
  selected: string[],
  onChange: (values: string[]) => void,
): FilterBarFacet {
  const options = [...known];
  for (const value of selected) {
    if (!options.some((option) => option.value === value)) options.push({ value, label: value });
  }
  if (selected.length > 1) options.push({ value: SEVERAL_VALUE, label: `${selected.length} selected` });
  return {
    key,
    label,
    options,
    value: selected.length === 0 ? null : selected.length === 1 ? selected[0] : SEVERAL_VALUE,
    onChange: (value) => {
      if (value === SEVERAL_VALUE) return;
      onChange(value === null ? [] : [value]);
    },
  };
}

/**
 * FilterBar dimensions for the scope: an environment picker once a project
 * has more than one environment, and one picker per label key. Options show
 * the label's name and filter by its id; a name two ids share shows the id.
 */
export function runScopeFacets(
  facets: RunLabelFacets | null,
  scope: RunScope,
  onChange: (next: RunScope) => void,
): FilterBarFacet[] {
  const result: FilterBarFacet[] = [];
  const environments = facets?.environments ?? [];
  if (environments.length > 1 || scope.environments.length > 0) {
    result.push(
      pickerOf(
        "environment",
        "Environment",
        environments.map((bucket) => ({ value: bucket.value, label: bucket.value })),
        scope.environments,
        (values) => onChange({ ...scope, environments: values }),
      ),
    );
  }

  const keys = new Map((facets?.labels ?? []).map((facet) => [facet.key, facet.values]));
  for (const key of Object.keys(scope.labels)) if (!keys.has(key)) keys.set(key, []);
  for (const [key, values] of [...keys].sort(([a], [b]) => a.localeCompare(b))) {
    const names = new Map<string, number>();
    for (const value of values) names.set(value.name, (names.get(value.name) ?? 0) + 1);
    result.push(
      pickerOf(
        `label:${key}`,
        key,
        values.map((value) => ({
          value: value.id,
          label: (names.get(value.name) ?? 0) > 1 ? `${value.name} (${value.id})` : value.name,
        })),
        scope.labels[key] ?? [],
        (ids) => {
          const labels = { ...scope.labels };
          if (ids.length > 0) labels[key] = ids;
          else delete labels[key];
          onChange({ ...scope, labels });
        },
      ),
    );
  }
  return result;
}

// ============================================================================
// Scope dimensions for the Runs filter rail
// ============================================================================

/** `@` cannot appear in a label key, so this dimension key cannot collide. */
export const ENVIRONMENT_DIMENSION = "@environment";

/** One filterable dimension: the environment, or one label key. */
export interface RunScopeDimension {
  key: string;
  label: string;
  values: { id: string; name: string; count: number }[];
}

/** A selected value, resolved to its display name for chips. */
export interface RunScopeChip {
  key: string;
  label: string;
  id: string;
  name: string;
}

/**
 * The dimensions a project's runs actually carry, in rail order: Environment
 * first, then label keys alphabetically. The Environment dimension appears
 * only once it is worth filtering (more than one value, or one already
 * selected), matching the pickers it replaces. A value the URL selects stays
 * listed even when no recent batch carries it, so a shared link never leaves
 * a filter applied but invisible.
 */
export function runScopeDimensions(
  facets: RunLabelFacets | null,
  scope: RunScope,
): RunScopeDimension[] {
  const dims: RunScopeDimension[] = [];
  const environments = (facets?.environments ?? []).map((bucket) => ({
    id: bucket.value,
    name: bucket.value,
    count: bucket.count,
  }));
  if (environments.length > 1 || scope.environments.length > 0) {
    dims.push(
      withCarried(
        { key: ENVIRONMENT_DIMENSION, label: "Environment", values: environments },
        scope.environments,
      ),
    );
  }
  for (const facet of facets?.labels ?? []) {
    dims.push(
      withCarried(
        { key: facet.key, label: facet.key, values: facet.values },
        scope.labels[facet.key] ?? [],
      ),
    );
  }
  for (const [key, ids] of Object.entries(scope.labels)) {
    if (!dims.some((dim) => dim.key === key)) {
      dims.push(withCarried({ key, label: key, values: [] }, ids));
    }
  }
  return dims;
}

/** The scope with one value added or removed. */
export function toggleRunScopeValue(scope: RunScope, key: string, id: string): RunScope {
  const current =
    key === ENVIRONMENT_DIMENSION ? scope.environments : (scope.labels[key] ?? []);
  const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  if (key === ENVIRONMENT_DIMENSION) return { ...scope, environments: next };
  const labels = { ...scope.labels };
  if (next.length > 0) labels[key] = next;
  else delete labels[key];
  return { ...scope, labels };
}

/** Every selected value across dimensions. Chips follow the dimension order
 * (Environment first, then label keys); no click-order recency is tracked. */
export function runScopeChips(scope: RunScope, dims: RunScopeDimension[]): RunScopeChip[] {
  return dims.flatMap((dim) =>
    scopeValuesOf(scope, dim.key).map((id) => ({
      key: dim.key,
      label: dim.label,
      id,
      name: dim.values.find((value) => value.id === id)?.name ?? id,
    })),
  );
}

/** Dimensions narrowed to a search: a matching key keeps all its values,
 * otherwise only matching values survive. */
export function filterRunScopeDimensions(
  dims: RunScopeDimension[],
  query: string,
): RunScopeDimension[] {
  const q = query.trim().toLowerCase();
  if (!q) return dims;
  return dims.flatMap((dim) => {
    if (dim.label.toLowerCase().includes(q)) return [dim];
    const values = dim.values.filter((value) => value.name.toLowerCase().includes(q));
    return values.length > 0 ? [{ ...dim, values }] : [];
  });
}

function scopeValuesOf(scope: RunScope, key: string): string[] {
  return key === ENVIRONMENT_DIMENSION ? scope.environments : (scope.labels[key] ?? []);
}

function withCarried(dim: RunScopeDimension, selected: string[]): RunScopeDimension {
  const missing = selected
    .filter((id) => !dim.values.some((value) => value.id === id))
    .map((id) => ({ id, name: id, count: 0 }));
  return missing.length > 0 ? { ...dim, values: [...dim.values, ...missing] } : dim;
}
