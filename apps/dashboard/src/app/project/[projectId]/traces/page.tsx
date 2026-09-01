import { apiClient } from "@/lib/api-client";
import { getProject } from "@/lib/projects-api";
import {
  fetchSpanFieldFacets,
  getTraceFilterOptions,
  listTraces,
  listTraceSessions,
  type PaginatedTraceSummary,
} from "@/lib/traces-api";

async function projectHasTraces(projectId: string): Promise<boolean> {
  try {
    const resp = await apiClient<{ has_traces?: boolean }>(
      `/v1/projects/${projectId}/onboarding-status`,
      { cache: "no-store" },
    );
    return Boolean(resp.has_traces);
  } catch {
    return true; // On fetch failure, default to the copy-only empty state.
  }
}
import { TracesPageClient } from "./traces-page-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Traces" };

export default async function TracesPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const routeParams = await params;
  const projectId = routeParams.projectId;
  const queryParams = await searchParams;
  const view = typeof queryParams.view === "string" ? queryParams.view : "list";

  const page = queryParams.page ? Number(queryParams.page) : 0;
  const pageSize = queryParams.page_size ? Number(queryParams.page_size) : 40;
  let paginatedData: PaginatedTraceSummary | null = null;
  let error: string | null = null;

  const traceListParams = {
    project: projectId,
    taskId: queryParams.task_id ? String(queryParams.task_id) : undefined,
    environment: queryParams.environment ? String(queryParams.environment) : undefined,
    sessionId: queryParams.session_id ? String(queryParams.session_id) : undefined,
    userId: queryParams.user_id ? String(queryParams.user_id) : undefined,
    tags: queryParams.tags ? String(queryParams.tags) : undefined,
    models: queryParams.models ? String(queryParams.models) : undefined,
    metricName: queryParams.metric_name ? String(queryParams.metric_name) : undefined,
    minScore: queryParams.min_score ? String(queryParams.min_score) : undefined,
    maxScore: queryParams.max_score ? String(queryParams.max_score) : undefined,
    search: queryParams.search ? String(queryParams.search) : undefined,
    service: queryParams.service ? String(queryParams.service) : undefined,
    operation: queryParams.operation ? String(queryParams.operation) : undefined,
    spanText: queryParams.span_text ? String(queryParams.span_text) : undefined,
    spanFilter: queryParams.span_filter ? String(queryParams.span_filter) : undefined,
    minDurationMs: queryParams.min_duration_ms
      ? String(queryParams.min_duration_ms)
      : undefined,
    maxDurationMs: queryParams.max_duration_ms
      ? String(queryParams.max_duration_ms)
      : undefined,
    createdAfter: queryParams.created_after ? String(queryParams.created_after) : undefined,
    createdBefore: queryParams.created_before ? String(queryParams.created_before) : undefined,
    status: queryParams.status ? String(queryParams.status) : undefined,
    sortBy: queryParams.sort_by ? String(queryParams.sort_by) : undefined,
    sortOrder: queryParams.sort_order ? String(queryParams.sort_order) : undefined,
    bookmarked: queryParams.bookmarked === "true" ? true : undefined,
    page,
    pageSize,
  };

  // The three fetches are independent — run them concurrently instead of
  // paying the list query before the options/sessions fan-out even starts.
  // The list promise never rejects, so the fallback path below can still
  // await it when the options/sessions fan-out throws.
  const listPromise = listTraces(traceListParams).catch((e: unknown) => {
    error = e instanceof Error ? e.message : "Failed to fetch traces";
    return null;
  });

  let canWrite = true;
  try {
    const [listResult, filterOptions, sessionsData, spanFields, hasTraces] = await Promise.all([
      listPromise,
      getTraceFilterOptions(),
      view === "sessions" ? listTraceSessions(
        projectId,
        page,
        pageSize,
      ) : Promise.resolve(null),
      fetchSpanFieldFacets(projectId),
      projectHasTraces(projectId),
    ]);
    // Bookmark/delete/export are member-tier writes: viewers never see
    // them. Best-effort — a failed fetch keeps the affordances.
    canWrite = await getProject(projectId)
      .then((project) => project.permissions?.can_run_tasks !== false)
      .catch(() => true);
    paginatedData = listResult;
    return (
      <main className="h-full flex flex-col">
        <TracesPageClient
          projectId={projectId}
          traces={paginatedData?.data ?? []}
          error={error}
          pagination={paginatedData ? {
            totalCount: paginatedData.totalCount,
            page: paginatedData.page,
            pageSize: paginatedData.pageSize,
            totalPages: paginatedData.totalPages,
          } : undefined}
          filterOptions={filterOptions}
          spanFieldOptions={spanFields ? { services: spanFields.services.map((s) => s.value), operations: spanFields.operations.map((o) => o.value) } : undefined}
          hasTraces={hasTraces}
          sessions={sessionsData?.data ?? undefined}
          canWrite={canWrite}
          sessionsPagination={sessionsData ? {
            totalCount: sessionsData.totalCount,
            page: sessionsData.page,
            pageSize: sessionsData.pageSize,
            totalPages: sessionsData.totalPages,
          } : undefined}
          view={view}
        />
      </main>
    );
  } catch {}

  paginatedData = await listPromise;

  return (
    <main className="h-full flex flex-col">
      <TracesPageClient
        projectId={projectId}
        traces={paginatedData?.data ?? []}
        error={error}
        pagination={paginatedData ? {
          totalCount: paginatedData.totalCount,
          page: paginatedData.page,
          pageSize: paginatedData.pageSize,
          totalPages: paginatedData.totalPages,
        } : undefined}
        view={view}
      />
    </main>
  );
}
