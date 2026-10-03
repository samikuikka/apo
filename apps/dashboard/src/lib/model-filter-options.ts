export type ModelPickerOption = {
  model: string;
  count: number;
  /** Retired from this list by a project member. */
  archived: boolean;
};

/**
 * The models the filter list shows: everything not archived, plus anything the
 * active filter selects.
 *
 * The second half is the point — a saved view or a shared `?model=` link can
 * name a model that was archived afterwards, and dropping it would leave the
 * filter applied but invisible and unclearable.
 */
export function visibleModels(
  options: ModelPickerOption[],
  selected: Set<string>,
): ModelPickerOption[] {
  return options.filter((o) => !o.archived || selected.has(o.model));
}

export type ModelProviderGroup = {
  /** Prefix before the last `/` (``other`` when the id has none). */
  provider: string;
  models: ModelPickerOption[];
  /** Sum of the group's run counts, for the section header. */
  totalRuns: number;
};

/** More models than this and the menu sections by provider. */
const GROUP_MIN_MODELS = 8;
/** Grouping pays off only when several providers contribute several models. */
const GROUP_MIN_MULTI_GROUPS = 2;

const OTHER_PROVIDER = "other";

/**
 * Section a long model list by provider prefix, mirroring `shortModel`'s split
 * (the last `/`): `deepseek/deepseek-v4.1-flash` → the `deepseek` section,
 * shown as `deepseek-v4.1-flash`.
 *
 * Returns `null` when the list is better flat — few models overall, or almost
 * every model its own provider (sections would be pure chrome). Models without
 * a prefix land in a trailing `other` section. Group order follows first
 * appearance in `options`, which callers pass count-descending, so the
 * busiest provider leads.
 */
export function groupModelsByProvider(
  options: ModelPickerOption[],
): ModelProviderGroup[] | null {
  if (options.length <= GROUP_MIN_MODELS) return null;

  const groups = new Map<string, ModelPickerOption[]>();
  for (const option of options) {
    const slash = option.model.lastIndexOf("/");
    const provider = slash >= 0 ? option.model.slice(0, slash) : OTHER_PROVIDER;
    const bucket = groups.get(provider);
    if (bucket) bucket.push(option);
    else groups.set(provider, [option]);
  }

  const multi = [...groups.values()].filter((b) => b.length >= 2).length;
  if (multi < GROUP_MIN_MULTI_GROUPS) return null;

  // `other` (no prefix) always sorts last; providers keep first-appearance
  // order, which callers pass count-descending, so the busiest provider leads.
  const ordered = [...groups.entries()].sort(([a], [b]) =>
    a === OTHER_PROVIDER ? 1 : b === OTHER_PROVIDER ? -1 : 0,
  );
  return ordered.map(([provider, models]) => ({
    provider,
    models,
    totalRuns: models.reduce((sum, m) => sum + m.count, 0),
  }));
}
