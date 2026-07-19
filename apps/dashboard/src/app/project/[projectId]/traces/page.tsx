import {
  getTraceFilterOptions,
  listTraces,
  listTraceSessions,
  type PaginatedTraceSummary,
} from "@/lib/traces-api";
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

  try {
    paginatedData = await listTraces(traceListParams);
  } catch (e: any) {
    error = e.message || "Failed to fetch traces";
  }

  try {
    const [filterOptions, sessionsData] = await Promise.all([
      getTraceFilterOptions(),
      view === "sessions" ? listTraceSessions(
        projectId,
        page,
        pageSize,
      ) : Promise.resolve(null),
    ]);
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
          sessions={sessionsData?.data ?? undefined}
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
