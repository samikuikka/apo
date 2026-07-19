import type {
  LoggedCall,
  Trace as SharedTrace,
  TraceDetail as SharedTraceDetail,
  TraceMetric as SharedTraceMetric,
} from "@/components/trace-detail";
import { apiClient } from "./api-client";
import { isApiError } from "./api-error";
import { getBrowserBackendBaseUrl } from "./config";
import { backendFetch } from "./backend-fetch";

export interface TraceMetric {
  metric_name: string;
  metric_type: "quality" | "aggregate";
  score: number;
  reasoning?: string;
  meta?: Record<string, unknown>;
  created_at: string;
}

interface TraceSummaryTransport {
  id: string;
  project: string;
  flow_name: string | null;
  task_id: string | null;
  version: string | null;
  session_id: string | null;
  environment: string;
  tags: string[];
  user_id: string | null;
  primary_model: string | null;
  call_count: number;
  duration_ms: number | null;
  created_at: string;
  completed_at: string | null;
  status: string;
  error_count: number;
  warning_count: number;
  metrics: TraceMetric[];
  input_preview: string | null;
  output_preview: string | null;
  bookmarked: boolean;
  is_public: boolean;
}

export interface TraceSummary {
  id: string;
  project: string;
  scopeKey: string | null;
  task_id: string | null;
  version: string | null;
  session_id: string | null;
  environment: string;
  tags: string[];
  user_id: string | null;
  primary_model: string | null;
  call_count: number;
  duration_ms: number | null;
  created_at: string;
  completed_at: string | null;
  status: string;
  error_count: number;
  warning_count: number;
  metrics: TraceMetric[];
  input_preview: string | null;
  output_preview: string | null;
  bookmarked: boolean;
  is_public: boolean;
}

export type TraceDetail = SharedTraceDetail;

type TraceTransport = Omit<SharedTrace, "scopeKey"> & {
  flow_name: string | null;
};

interface TraceDetailTransport {
  run: TraceTransport;
  metrics: SharedTraceMetric[];
  calls: LoggedCall[];
}

interface PaginatedTraceSummaryTransport {
  data: TraceSummaryTransport[];
  total_count: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface PaginatedTraceSummary {
  data: TraceSummary[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface TraceFilterOptions {
  projects?: string[];
  tasks?: string[];
  models?: string[];
  metrics?: string[];
}

export interface TraceListParams {
  project?: string;
  taskId?: string;
  environment?: string;
  sessionId?: string;
  userId?: string;
  tags?: string;
  models?: string;
  metricName?: string;
  minScore?: string;
  maxScore?: string;
  search?: string;
  minDurationMs?: string;
  maxDurationMs?: string;
  createdAfter?: string;
  createdBefore?: string;
  status?: string;
  sortBy?: string;
  sortOrder?: string;
  bookmarked?: boolean;
  page?: number;
  pageSize?: number;
}

export interface TraceExportResult {
  filename: string;
  media_type: string;
  data: string;
}

export interface FacetBucket {
  value: string;
  count: number;
}

export interface TraceFacets {
  status: FacetBucket[];
  models: FacetBucket[];
  environments: FacetBucket[];
  tags: FacetBucket[];
  users: FacetBucket[];
  sessions: FacetBucket[];
  scores: FacetBucket[];
}

const NO_CACHE = { cache: "no-store" } as const;

function normalizeTraceSummary(
  trace: TraceSummaryTransport,
): TraceSummary {
  return {
    id: trace.id,
    project: trace.project,
    scopeKey: trace.flow_name,
    task_id: trace.task_id,
    version: trace.version,
    session_id: trace.session_id,
    environment: trace.environment,
    tags: trace.tags,
    user_id: trace.user_id,
    primary_model: trace.primary_model,
    call_count: trace.call_count,
    duration_ms: trace.duration_ms,
    created_at: trace.created_at,
    completed_at: trace.completed_at,
    status: trace.status,
    error_count: trace.error_count,
    warning_count: trace.warning_count,
    metrics: trace.metrics,
    input_preview: trace.input_preview,
    output_preview: trace.output_preview,
    bookmarked: trace.bookmarked,
    is_public: trace.is_public,
  };
}

function normalizeTraceDetail(
  traceDetail: TraceDetailTransport,
): SharedTraceDetail {
  const { flow_name, ...run } = traceDetail.run;
  return {
    ...traceDetail,
    run: {
      ...run,
      scopeKey: flow_name ?? null,
    },
  };
}

export async function listTraces(
  params: TraceListParams,
): Promise<PaginatedTraceSummary> {
  const data = await apiClient<PaginatedTraceSummaryTransport>("/v1/runs", {
    ...NO_CACHE,
    query: {
      project: params.project,
      task_id: params.taskId,
      environment: params.environment,
      session_id: params.sessionId,
      user_id: params.userId,
      tags: params.tags,
      models: params.models,
      metric_name: params.metricName,
      min_score: params.minScore,
      max_score: params.maxScore,
      search: params.search,
      min_duration_ms: params.minDurationMs,
      max_duration_ms: params.maxDurationMs,
      created_after: params.createdAfter,
      created_before: params.createdBefore,
      status: params.status,
      sort_by: params.sortBy,
      sort_order: params.sortOrder,
      bookmarked: params.bookmarked,
      page: params.page ?? 0,
      page_size: params.pageSize ?? 40,
    },
  });
  return {
    data: data.data.map(normalizeTraceSummary),
    totalCount: data.total_count,
    page: data.page,
    pageSize: data.page_size,
    totalPages: data.total_pages,
  };
}

// Four parallel fetches where each tolerates individual failure — stays on
// the low-level fetch so a failing endpoint returns undefined rather than
// rejecting the whole Promise.all.
export async function getTraceFilterOptions(): Promise<TraceFilterOptions> {
  const [projectsRes, tasksRes, modelsRes, metricsRes] = await Promise.all([
    backendFetch(`${getBrowserBackendBaseUrl()}/v1/runs/distinct-projects`, NO_CACHE),
    backendFetch(`${getBrowserBackendBaseUrl()}/v1/runs/distinct-tasks`, NO_CACHE),
    backendFetch(`${getBrowserBackendBaseUrl()}/v1/runs/distinct-models`, NO_CACHE),
    backendFetch(`${getBrowserBackendBaseUrl()}/v1/runs/distinct-metrics`, NO_CACHE),
  ]);

  const [projects, tasks, models, metrics] = await Promise.all([
    projectsRes.ok ? projectsRes.json() : undefined,
    tasksRes.ok ? tasksRes.json() : undefined,
    modelsRes.ok ? modelsRes.json() : undefined,
    metricsRes.ok ? metricsRes.json() : undefined,
  ]);

  return { projects, tasks, models, metrics };
}

export interface AdjacentTraces {
  prev_id: string | null;
  next_id: string | null;
}

export async function getAdjacentTraces(
  runId: string,
  sortBy?: string,
  sortOrder?: string,
  projectId?: string,
): Promise<AdjacentTraces> {
  try {
    return await apiClient<AdjacentTraces>(`/v1/runs/${runId}/adjacent`, {
      ...NO_CACHE,
      query: { sort_by: sortBy, sort_order: sortOrder, project: projectId },
    });
  } catch {
    return { prev_id: null, next_id: null };
  }
}

export async function getTraceDetail(
  runId: string,
  projectId?: string,
): Promise<TraceDetail> {
  try {
    const data = await apiClient<TraceDetailTransport>(`/v1/runs/${runId}`, {
      ...NO_CACHE,
      query: { project: projectId },
    });
    return normalizeTraceDetail(data);
  } catch (error) {
    if (isApiError(error) && error.status === 404) {
      throw new Error("Trace not found");
    }
    throw error;
  }
}

/**
 * Fetch a published trace without authentication. Mirrors {@link getTraceDetail}
 * but hits the unauthenticated `/public/traces/{id}` endpoint, which the
 * backend allows through its auth middleware and Next.js allows through its
 * route middleware. Returns `null` on 404 (private / missing) so the page can
 * render a friendly not-found state instead of throwing.
 */
export async function getPublicTrace(runId: string): Promise<TraceDetail | null> {
  try {
    const data = await apiClient<TraceDetailTransport>(
      `/public/traces/${runId}`,
      NO_CACHE,
    );
    return normalizeTraceDetail(data);
  } catch (error) {
    if (isApiError(error) && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export const bulkDeleteTraces = (runIds: string[]): Promise<void> =>
  apiClient("/v1/runs/bulk-delete", {
    method: "POST",
    body: { run_ids: runIds },
  });

export const exportTraces = (
  runIds: string[],
): Promise<TraceExportResult> =>
  apiClient("/v1/runs/bulk-export", {
    method: "POST",
    body: { run_ids: runIds, format: "json" },
  });

interface TraceSessionSummaryTransport {
  session_id: string;
  trace_count: number;
  first_trace_at: string;
  last_trace_at: string;
  total_cost: number;
  total_tokens: number;
}

export interface TraceSessionSummary {
  id: string;
  traceCount: number;
  firstTraceAt: string;
  lastTraceAt: string;
  totalCost: number;
  totalTokens: number;
}

interface PaginatedTraceSessionSummaryTransport {
  data: TraceSessionSummaryTransport[];
  total_count: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface PaginatedTraceSessionSummary {
  data: TraceSessionSummary[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function normalizeTraceSessionSummary(
  session: TraceSessionSummaryTransport,
): TraceSessionSummary {
  return {
    id: session.session_id,
    traceCount: session.trace_count,
    firstTraceAt: session.first_trace_at,
    lastTraceAt: session.last_trace_at,
    totalCost: session.total_cost,
    totalTokens: session.total_tokens,
  };
}

export async function listTraceSessions(
  project?: string,
  page: number = 0,
  pageSize: number = 20,
): Promise<PaginatedTraceSessionSummary | null> {
  try {
    const data = await apiClient<PaginatedTraceSessionSummaryTransport>(
      "/v1/runs/sessions",
      { ...NO_CACHE, query: { project, page, page_size: pageSize } },
    );
    return {
      data: data.data.map(normalizeTraceSessionSummary),
      totalCount: data.total_count,
      page: data.page,
      pageSize: data.page_size,
      totalPages: data.total_pages,
    };
  } catch {
    return null;
  }
}

export const toggleBookmark = (
  runId: string,
): Promise<{ id: string; bookmarked: boolean }> =>
  apiClient(`/v1/runs/${runId}/bookmark`, { method: "PATCH" });

export const saveCorrection = (
  runId: string,
  callId: string,
  correctedOutput: string | null,
): Promise<{ id: string; corrected_output: string | null }> =>
  apiClient(`/v1/runs/${runId}/calls/${callId}/correction`, {
    method: "PATCH",
    body: { corrected_output: correctedOutput },
  });

export const toggleVisibility = (
  runId: string,
): Promise<{ id: string; is_public: boolean }> =>
  apiClient(`/v1/runs/${runId}/visibility`, { method: "PATCH" });
