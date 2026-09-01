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
