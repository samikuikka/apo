/**
 * The run cohort — which model, effort tier, and date window a page is showing.
 *
 * Tasks and Runs answer different questions about the same cohort, and they
 * hold it in different places: Tasks in the active evidence-view tab and Runs
 * in the URL. This value object is the small, framework-free handoff between
 * those two representations. The task detail page is the third consumer: task
 * cards link into it with the cohort as query params, so its run history
 * answers the same question the task list's stats were scoped to.
 *
 * Status and search deliberately do not travel: status has different meanings
 * on the two pages, and their search boxes match different fields.
 */
export interface RunCohort {
  model: string | null;
  effort: string | null;
  since: string | null;
  /** Observed serving host (issue #307) — single-valued in the drill-down
   * vocabulary, like model. Evidence views don't scope by it yet; they
   * publish null. */
  provider: string | null;
}

export const EMPTY_RUN_COHORT: RunCohort = {
  model: null,
  effort: null,
  since: null,
  provider: null,
};

/**
 * Append a cohort as the query parameters the Runs page reads. An empty cohort
 * leaves the href untouched, so a plain navigation link stays plain.
 */
export function hrefWithRunCohort(href: string, cohort: RunCohort): string {
  const params = new URLSearchParams();
  if (cohort.model) params.set("model", cohort.model);
  if (cohort.effort) params.set("effort", cohort.effort);
  if (cohort.since) params.set("since", cohort.since);
  if (cohort.provider) params.set("provider", cohort.provider);
  const query = params.toString();
  if (!query) return href;
  return `${href}${href.includes("?") ? "&" : "?"}${query}`;
}

/**
 * The shape `useSearchParams`/RSC `searchParams` hand to a page: each key maps
 * to one value, several values, or nothing at all.
 */
export type SearchParamQuery = Record<string, string | string[] | undefined>;

/** Parse the cohort vocabulary (`?model=&effort=&since=`) from page search params. */
export function parseRunCohort(query: SearchParamQuery): RunCohort {
  const first = (key: string): string | null => {
    const value = query[key];
    const single = Array.isArray(value) ? value[0] : value;
    return typeof single === "string" && single ? single : null;
  };
  return {
    model: first("model"),
    effort: first("effort"),
    since: first("since"),
    provider: first("provider"),
  };
}

/**
 * The Runs page's variant of the cohort hop: its multi-select filters pack as
 * comma-joined values ("a,b"), while the drill-down vocabulary is
 * single-valued. Only an unambiguous single selection survives the hop —
 * forwarding "a,b" would filter for a model literally named "a,b".
 */
export function parseDrilldownCohort(query: SearchParamQuery): RunCohort {
  const one = (key: string): string | null => {
    const value = query[key];
    const single = Array.isArray(value) ? value[0] : value;
    if (typeof single !== "string" || !single) return null;
    const parts = single.split(",").filter(Boolean);
    return parts.length === 1 ? parts[0] : null;
  };
  return {
    model: one("model"),
    effort: one("effort"),
    since: one("since"),
    provider: one("provider"),
  };
}

/**
 * Append the saved-view identity param (`?view=`). It is informational — the
 * tasks page uses it to re-select the tab, the task detail page to name the
 * scope's origin — and degrades to a plain link when absent.
 */
export function withViewId(href: string, viewId: string | null | undefined): string {
  if (!viewId) return href;
  return `${href}${href.includes("?") ? "&" : "?"}view=${encodeURIComponent(viewId)}`;
}
