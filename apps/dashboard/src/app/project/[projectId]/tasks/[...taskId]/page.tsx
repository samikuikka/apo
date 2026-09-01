import {
  getProjectAgentTask,
  listTaskRuns,
  type TaskRunCohortFilter,
} from "@/lib/agent-task-api";
import { fetchTaskViewConfigFacets } from "@/lib/agent-task-view-api";
import { getProject } from "@/lib/projects-api";
import { Suspense } from "react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TaskFileBrowser } from "@/components/agent-task-files/task-file-browser";
import { TaskRunHistory } from "./task-run-history";
import { RunHistoryScopeBar } from "./run-history-scope-bar";
import Link from "next/link";
import type { Metadata } from "next";
import { FolderOpen } from "lucide-react";
import { parseRunCohort, withViewId } from "@/lib/run-cohort";

export const dynamic = "force-dynamic";

// The route is a catch-all (`tasks/[...taskId]`) because task ids are
// hierarchical paths with slashes (e.g. "openai-agent/data-extraction").
// Join the captured segments back into the slash-delimited id the API expects.
const joinTaskId = (segments: string[]): string => segments.join("/");

// The run-history scope, carried from the Tasks page's active evidence view
// (`?model=&effort=&since=`, the same vocabulary the Runs page reads) plus
// the detail page's own run-status chips and the informational `?view=`.
// Absent params mean all-history. See `lib/run-cohort`.
function parseScope(query: Record<string, string | string[] | undefined>): {
  cohort: TaskRunCohortFilter;
  scopeActive: boolean;
  viewId: string | null;
} {
  const cohort = parseRunCohort(query);
  const statusRaw = query.status;
  const statusList = (Array.isArray(statusRaw) ? statusRaw : [statusRaw]).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const viewRaw = query.view;
  const viewSingle = Array.isArray(viewRaw) ? viewRaw[0] : viewRaw;
  const viewId = typeof viewSingle === "string" && viewSingle ? viewSingle : null;
  const scopeActive =
    cohort.model !== null ||
    cohort.effort !== null ||
    cohort.since !== null ||
    statusList.length > 0;
  return {
    cohort: statusList.length > 0 ? { ...cohort, status: statusList } : cohort,
    scopeActive,
    viewId,
  };
}

// Tab title: "Task: <display_name>". Falls back to "Task" on any failure.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string; taskId: string[] }>;
}): Promise<Metadata> {
  const { projectId, taskId: taskIdSegments } = await params;
  const taskId = joinTaskId(taskIdSegments);
  try {
    const task = await getProjectAgentTask(projectId, taskId);
    return { title: `Task: ${task.display_name}` };
  } catch {
    return { title: "Task" };
  }
}

const EMPTY_TASK_RUNS: Awaited<ReturnType<typeof listTaskRuns>> = [];

export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; taskId: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId, taskId: taskIdSegments }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  const taskId = joinTaskId(taskIdSegments);
  const { cohort, scopeActive, viewId } = parseScope(query);

  let task: Awaited<ReturnType<typeof getProjectAgentTask>> | null = null;
  let taskRuns = EMPTY_TASK_RUNS;
  let totalRuns = 0;
  let facets: Awaited<ReturnType<typeof fetchTaskViewConfigFacets>> = [];
  let error: string | null = null;
  let canDeleteRuns = false;

  try {
    // The scoped list is what renders; the unscoped twin exists only to give
    // the count line its "N of M" denominator. Facets feed the control menus
    // and are best-effort (a facets failure must not blank the run history).
    // The project read feeds the run-delete role gate (best-effort too).
    const [resolved, scoped, all, facetResult, project] = await Promise.all([
      getProjectAgentTask(projectId, taskId),
      listTaskRuns(taskId, projectId, cohort),
      scopeActive ? listTaskRuns(taskId, projectId) : Promise.resolve(null),
      fetchTaskViewConfigFacets(projectId).catch(() => []),
      getProject(projectId).catch(() => null),
    ]);
    task = resolved;
    taskRuns = scoped;
    totalRuns = scopeActive ? (all ?? scoped).length : scoped.length;
    facets = facetResult;
    canDeleteRuns =
      project?.current_user_role === "owner" ||
      project?.current_user_role === "admin";
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to fetch task details";
  }

  if (error) {
    return (
      <div className="mx-auto w-full max-w-6xl flex flex-col">
        <div className="border-b border-border px-6 py-5">
          <Link
            href={`/project/${projectId}/tasks`}
            className="text-[12px] text-muted-foreground hover:text-foreground"
          >
            &larr; Tasks
          </Link>
        </div>
        <div className="mx-6 mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
          {error}
        </div>
      </div>
    );
  }

  if (!task) return null;

  const fileCount = (task.has_checks ? 1 : 0) + 1;

  return (
    <div className="mx-auto w-full max-w-6xl flex flex-col">
      {/* Page header */}
      <div className="border-b border-border px-6 py-5">
        <Link
          href={withViewId(`/project/${projectId}/tasks`, viewId)}
          className="text-[12px] text-muted-foreground hover:text-foreground"
        >
          &larr; Tasks
        </Link>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-3">
          <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
          <h1 className="min-w-0 truncate text-[20px] font-semibold tracking-tight">{task.display_name}</h1>
          <Badge variant="outline" className="text-[10px]">{task.adapter_name}</Badge>
        </div>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-mono text-[10px]">{task.folder_path || "(root)"}</Badge>
          <Badge variant="outline" className="text-[10px]">{fileCount} files</Badge>
          <Badge variant="outline" className="text-[10px]">
            {scopeActive
              ? `${taskRuns.length} of ${totalRuns} task runs in view`
              : `${taskRuns.length} task runs`}
          </Badge>
        </div>
      </div>

      {/* Run-history scope: the shared filter bar in its own strip, hosted the
          same way the Tasks and Runs pages host it. The bar reads the search
          params client-side, so it needs a Suspense boundary — without one,
          Next.js would force the whole page into client-side rendering. */}
      <div className="border-b border-border bg-muted/10 px-6 py-2.5">
        <Suspense fallback={null}>
          <RunHistoryScopeBar projectId={projectId} facets={facets} />
        </Suspense>
      </div>

      <Tabs defaultValue="runs" className="flex flex-col">
        <div className="border-b border-border px-6">
          <TabsList className="h-10 bg-card">
            <TabsTrigger value="runs" className="px-4 text-[13px]">Task Run History</TabsTrigger>
            <TabsTrigger value="files" className="px-4 text-[13px]">
              Files
              <Badge variant="outline" className="ml-1.5 text-[10px] px-1.5 py-0">
                {fileCount}
              </Badge>
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="runs" className="mt-0">
          <TaskRunHistory runs={taskRuns} canDelete={canDeleteRuns} />
        </TabsContent>

        <TabsContent value="files" className="mt-0 p-6">
          <TaskFileBrowser
            taskId={taskId}
            projectId={projectId}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
