import {
  listAgentTaskBatchRuns,
  type AgentTaskBatchRunSummary,
  type ModelFacetOption,
  type ProviderFacetOption,
} from "@/lib/agent-task-api";
import { getProject, type ProjectTaskSource } from "@/lib/projects-api";
import { Suspense } from "react";
import { RunsClient } from "./runs-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Runs" };

export default async function RunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);

  const page = query.page ? Math.max(0, Number(query.page)) : 0;
  const pageSize = query.page_size ? Number(query.page_size) : 20;
  const q = typeof query.q === "string" ? query.q : undefined;
  // Multi-status arrives comma-joined (`?status=failed,error`); repeated
  // params from old links are folded into the same shape.
  const statusParam = Array.isArray(query.status)
    ? query.status.filter(Boolean).join(",") || undefined
    : typeof query.status === "string" && query.status
      ? query.status
      : undefined;
  const since = typeof query.since === "string" ? query.since : undefined;
  const modelParam = typeof query.model === "string" ? query.model : undefined;
  const models = modelParam ? modelParam.split(",").filter(Boolean) : undefined;
  const effortParam = typeof query.effort === "string" ? query.effort : undefined;
  const efforts = effortParam ? effortParam.split(",").filter(Boolean) : undefined;
  const providerParam = typeof query.provider === "string" ? query.provider : undefined;
  const providers = providerParam ? providerParam.split(",").filter(Boolean) : undefined;

  let batchRuns: AgentTaskBatchRunSummary[] = [];
  let totalCount = 0;
  let totalPages = 0;
  let modelFacets: ModelFacetOption[] = [];
  let providerFacets: ProviderFacetOption[] = [];
  let error: string | null = null;
  let taskSource: ProjectTaskSource | null = null;

  // Fetch runs list and project in parallel — they're independent.
  const projectPromise = getProject(projectId).catch(() => null);

  try {
    const paginated = await listAgentTaskBatchRuns(projectId, {
      q,
      status: statusParam,
      since,
      model: models,
      effort: efforts,
      provider: providers,
      page,
      page_size: pageSize,
    });
    batchRuns = paginated.data;
    totalCount = paginated.total_count;
    totalPages = paginated.total_pages;
    modelFacets = paginated.model_facets;
    providerFacets = paginated.provider_facets;
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to fetch runs";
  }

  // Project result (started in parallel with the runs list).
  const project = await projectPromise;
  taskSource = project?.task_source ?? null;
  const canDeleteRuns =
    project?.current_user_role === "owner" || project?.current_user_role === "admin";

  return (
    <main className="h-full flex flex-col">
      <Suspense fallback={null}>
        <RunsClient
          batchRuns={batchRuns}
          providerFacets={providerFacets}
          error={error}
          taskSource={taskSource}
          totalCount={totalCount}
          page={page}
          pageSize={pageSize}
          totalPages={totalPages}
          modelFacets={modelFacets}
          canDeleteRuns={canDeleteRuns}
        />
      </Suspense>
    </main>
  );
}
