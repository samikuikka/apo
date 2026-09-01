"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback, useMemo } from "react";

export type TimePreset = "1h" | "24h" | "7d" | "30d" | "all" | "custom";

export interface TraceFilters {
  timePreset: TimePreset;
  created_after?: string;
  created_before?: string;
  project?: string;
  task_id?: string;
  environment?: string;
  session_id?: string;
  user_id?: string;
  status?: string;
  tags: string[];
  models: string[];
  metric_name?: string;
  min_score?: number;
  max_score?: number;
  search?: string;
  min_duration_ms?: number;
  max_duration_ms?: number;
  // Span-derived search
  service?: string;
  operation?: string;
  span_text?: string;
  span_predicates: SpanPredicate[];
}

export interface SpanPredicate {
  /**
   * Stable identity for React list keys. Filters are URL-backed and
   * re-parsed on every param write, so the id rides the span_filter JSON —
   * a fresh id per parse would remount (and defocus) the editor rows on
   * every keystroke. The backend ignores unknown keys in the payload.
   */
  id: string;
  field: string;
  op: string;
  value?: string | number | string[];
}

let predicateIdSeq = 0;

/** Mint a predicate id; uniqueness only needs to hold per browser session. */
export function nextPredicateId(): string {
  predicateIdSeq += 1;
  return `sp${predicateIdSeq}`;
}

export interface FilterActions {
  setTimePreset: (preset: TimePreset) => void;
  setCustomTimeRange: (start: Date, end: Date) => void;
  setProject: (project: string | undefined) => void;
  setTaskId: (taskId: string | undefined) => void;
  setEnvironment: (env: string | undefined) => void;
  setSessionId: (id: string | undefined) => void;
  setTags: (tags: string[]) => void;
  setModels: (models: string[]) => void;
  setMetricFilter: (metricName?: string, minScore?: number, maxScore?: number) => void;
  setSearch: (search: string | undefined) => void;
  setSpanSearch: (span: Partial<Pick<TraceFilters, "service" | "operation" | "span_text">>) => void;
  setSpanPredicates: (predicates: SpanPredicate[]) => void;
  setDurationRange: (min?: number, max?: number) => void;
  clearAllFilters: () => void;
  removeFilter: (key: keyof TraceFilters) => void;
}

function getDatetimeFromPreset(preset: TimePreset): { start?: string; end?: string } {
  const now = new Date();
  const end = now.toISOString();

  if (preset === "all" || preset === "custom") {
    return {};
  }

  const startMap: Record<TimePreset, Date> = {
    "1h": new Date(now.getTime() - 60 * 60 * 1000),
    "24h": new Date(now.getTime() - 24 * 60 * 60 * 1000),
    "7d": new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
    "30d": new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    all: now,
    custom: now,
  };

  return {
    start: startMap[preset].toISOString(),
    end,
  };
}

interface FilterHookConfig<Filters extends { timePreset: TimePreset; tags: string[] }> {
  parseFilters: (searchParams: URLSearchParams) => Filters;
  buildQueryString: (filters: Filters) => string;
  basePath: string;
  clearState: Filters;
  removeFilterOverrides?: (
    key: keyof Filters,
    filters: Filters
  ) => Filters | undefined;
}

function useFilterCore<Filters extends { timePreset: TimePreset; tags: string[] }>(
  config: FilterHookConfig<Filters>
) {
  const { parseFilters, buildQueryString, basePath, clearState, removeFilterOverrides } = config;
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  const filters = useMemo(() => parseFilters(searchParams), [searchParams, parseFilters]);

  const updateUrl = useCallback(
    (newFilters: Filters) => {
      const queryString = buildQueryString(newFilters);
      const resolvedBasePath = pathname?.startsWith("/project/")
        ? pathname.replace(/\/traces.*$/, "/traces") || basePath
        : basePath;
      router.push(`${resolvedBasePath}${queryString}`);
    },
    [router, pathname, basePath, buildQueryString]
  );

  const setTimePreset = useCallback(
    (preset: TimePreset) => {
      const { start, end } = getDatetimeFromPreset(preset);
      updateUrl({
        ...filters,
        timePreset: preset,
        created_after: start,
        created_before: end,
      } as Filters);
    },
    [filters, updateUrl]
  );

  const setCustomTimeRange = useCallback(
    (start: Date, end: Date) => {
      updateUrl({
        ...filters,
        timePreset: "custom",
        created_after: start.toISOString(),
        created_before: end.toISOString(),
      } as Filters);
    },
    [filters, updateUrl]
  );

  const clearAllFilters = useCallback(() => {
    updateUrl(clearState);
  }, [updateUrl, clearState]);

  const removeFilter = useCallback(
    (key: keyof Filters) => {
      const overridden = removeFilterOverrides?.(key, filters);
      if (overridden) {
        updateUrl(overridden);
        return;
      }

      const newFilters = { ...filters };
      if (key === "tags") {
        newFilters.tags = [];
      } else if (key === "timePreset") {
        newFilters.timePreset = "all" as TimePreset;
        delete (newFilters as Record<string, unknown>).created_after;
        delete (newFilters as Record<string, unknown>).created_before;
      } else {
        delete (newFilters as Record<string, unknown>)[key as string];
      }
      updateUrl(newFilters);
    },
    [filters, updateUrl, removeFilterOverrides]
  );

  const updateFilters = useCallback(
    (patch: Partial<Filters>) => {
      updateUrl({ ...filters, ...patch } as Filters);
    },
    [filters, updateUrl]
  );

  return {
    filters,
    setTimePreset,
    setCustomTimeRange,
    clearAllFilters,
    removeFilter,
    updateFilters,
  };
}

function parseSpanPredicates(raw: string | null): SpanPredicate[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is { field: string; op: string } =>
          typeof p === "object" &&
          p !== null &&
          typeof (p as { field?: unknown }).field === "string" &&
          typeof (p as { op?: unknown }).op === "string",
      )
      .map((p) => {
        const { id, ...rest } = p as { id?: unknown } & Record<string, unknown>;
        return {
          ...rest,
          // Links saved before predicate ids existed get one minted at parse
          // time; the next filter write persists it into the URL.
          id: typeof id === "string" && id ? id : nextPredicateId(),
        } as SpanPredicate;
      });
  } catch {
    return [];
  }
}

function parseTraceFilters(searchParams: URLSearchParams): TraceFilters {
  const timePreset = (searchParams.get("timePreset") as TimePreset) || "all";
  const { start, end } = getDatetimeFromPreset(timePreset);
  return {
    timePreset,
    created_after: searchParams.get("created_after") || start,
    created_before: searchParams.get("created_before") || end,
    project: searchParams.get("project") || undefined,
    task_id: searchParams.get("task_id") || undefined,
    environment: searchParams.get("environment") || undefined,
    session_id: searchParams.get("session_id") || undefined,
    user_id: searchParams.get("user_id") || undefined,
    status: searchParams.get("status") || undefined,
    tags: searchParams.get("tags")?.split(",").filter(Boolean) || [],
    models: searchParams.get("models")?.split(",").filter(Boolean) || [],
    metric_name: searchParams.get("metric_name") || undefined,
    min_score: searchParams.get("min_score") ? Number(searchParams.get("min_score")) : undefined,
    max_score: searchParams.get("max_score") ? Number(searchParams.get("max_score")) : undefined,
    search: searchParams.get("search") || undefined,
    service: searchParams.get("service") || undefined,
    operation: searchParams.get("operation") || undefined,
    span_text: searchParams.get("span_text") || undefined,
    span_predicates: parseSpanPredicates(searchParams.get("span_filter")),
    min_duration_ms: searchParams.get("min_duration_ms")
      ? Number(searchParams.get("min_duration_ms"))
      : undefined,
    max_duration_ms: searchParams.get("max_duration_ms")
      ? Number(searchParams.get("max_duration_ms"))
      : undefined,
  };
}

function buildTraceQueryString(filters: TraceFilters): string {
  const params = new URLSearchParams();

  // When timePreset is "all", explicitly drop date params so the URL is clean
  // and a stale created_after/created_before can't persist across navigation.
  if (filters.timePreset !== "all") params.set("timePreset", filters.timePreset);
  if (filters.timePreset !== "all" && filters.created_after) params.set("created_after", filters.created_after);
  if (filters.timePreset !== "all" && filters.created_before) params.set("created_before", filters.created_before);
  if (filters.project) params.set("project", filters.project);
  if (filters.task_id) params.set("task_id", filters.task_id);
  if (filters.environment) params.set("environment", filters.environment);
  if (filters.session_id) params.set("session_id", filters.session_id);
  if (filters.user_id) params.set("user_id", filters.user_id);
  if (filters.status) params.set("status", filters.status);
  if (filters.tags.length > 0) params.set("tags", filters.tags.join(","));
  if (filters.models.length > 0) params.set("models", filters.models.join(","));
  if (filters.metric_name) params.set("metric_name", filters.metric_name);
  if (filters.min_score !== undefined) params.set("min_score", filters.min_score.toString());
  if (filters.max_score !== undefined) params.set("max_score", filters.max_score.toString());
  if (filters.search) params.set("search", filters.search);
  if (filters.service) params.set("service", filters.service);
  if (filters.operation) params.set("operation", filters.operation);
  if (filters.span_text) params.set("span_text", filters.span_text);
  if (filters.span_predicates.length > 0) {
    params.set("span_filter", JSON.stringify(filters.span_predicates));
  }
  if (filters.min_duration_ms !== undefined) params.set("min_duration_ms", filters.min_duration_ms.toString());
  if (filters.max_duration_ms !== undefined) params.set("max_duration_ms", filters.max_duration_ms.toString());

  const queryString = params.toString();
  return queryString ? `?${queryString}` : "";
}

export function useFilters(): [filters: TraceFilters, actions: FilterActions] {
  const core = useFilterCore<TraceFilters>({
    parseFilters: parseTraceFilters,
    buildQueryString: buildTraceQueryString,
    basePath: "/traces",
    clearState: { timePreset: "all", tags: [], models: [], span_predicates: [] } as TraceFilters,
    removeFilterOverrides: (key, filters) => {
      if (key === "models") return { ...filters, models: [] };
      if (key === "metric_name") {
        const next = { ...filters };
        delete next.metric_name;
        delete next.min_score;
        delete next.max_score;
        return next;
      }
      return undefined;
    },
  });

  const actions: FilterActions = useMemo(
    () => ({
      setTimePreset: core.setTimePreset,
      setCustomTimeRange: core.setCustomTimeRange,
      setProject: (project) => core.updateFilters({ project } as Partial<TraceFilters>),
      setTaskId: (taskId) => core.updateFilters({ task_id: taskId } as Partial<TraceFilters>),
      setEnvironment: (env) => core.updateFilters({ environment: env } as Partial<TraceFilters>),
      setSessionId: (id) => core.updateFilters({ session_id: id } as Partial<TraceFilters>),
      setTags: (tags) => core.updateFilters({ tags } as Partial<TraceFilters>),
      setModels: (models) => core.updateFilters({ models } as Partial<TraceFilters>),
      setMetricFilter: (metricName, minScore, maxScore) =>
        core.updateFilters({
          metric_name: metricName,
          min_score: minScore,
          max_score: maxScore,
        } as Partial<TraceFilters>),
      setSearch: (search) => core.updateFilters({ search } as Partial<TraceFilters>),
      setSpanSearch: (span) => core.updateFilters(span as Partial<TraceFilters>),
      setSpanPredicates: (predicates) =>
        core.updateFilters({ span_predicates: predicates } as Partial<TraceFilters>),
      setDurationRange: (min, max) =>
        core.updateFilters({
          min_duration_ms: min,
          max_duration_ms: max,
        } as Partial<TraceFilters>),
      clearAllFilters: core.clearAllFilters,
      removeFilter: core.removeFilter as (key: keyof TraceFilters) => void,
    }),
    [core]
  );

  return [core.filters, actions];
}

export function hasActiveFilters(filters: TraceFilters): boolean {
  return (
    filters.timePreset !== "all" ||
    (filters.project ?? "") !== "" ||
    (filters.task_id ?? "") !== "" ||
    (filters.environment ?? "") !== "" ||
    (filters.session_id ?? "") !== "" ||
    (filters.user_id ?? "") !== "" ||
    (filters.status ?? "") !== "" ||
    filters.tags.length > 0 ||
    filters.models.length > 0 ||
    (filters.metric_name ?? "") !== "" ||
    (filters.search ?? "") !== "" ||
    (filters.service ?? "") !== "" ||
    (filters.operation ?? "") !== "" ||
    (filters.span_text ?? "") !== "" ||
    filters.span_predicates.length > 0 ||
    filters.min_duration_ms !== undefined ||
    filters.max_duration_ms !== undefined
  );
}
