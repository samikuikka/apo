import {
  getProjectAgentTask,
  listTaskRuns,
  type AgentTaskDetail,
  type TaskRunCohortFilter,
} from "@/lib/agent-task-api";
import { fetchTaskViewConfigFacets } from "@/lib/agent-task-view-api";
import { getProject } from "@/lib/projects-api";
import { isNotFoundStatus } from "@/lib/api-error";
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
import { providerLabels } from "@/lib/agent-task-api";

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
    cohort.provider !== null ||
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

// Page-aligned fetch bound: TaskRunHistory paginates 20 rows per page
// client-side, so 200 rows = 10 pages of the newest runs — enough for the
// drill-down without the default 1,000-row scan per task-page view (one
// bounded list call serves the page; the unfiltered "N of M" twin fetch is
// gone). API consumers can still ask for up to 5,000 explicitly.
const TASK_RUN_HISTORY_LIMIT = 200;

/** Serving-host facet over this task's runs (issue #307): route-wins labels
 * with per-label run counts, feeding the run-history Hosts filter. */
function hostOptionsFromRuns(
  runs: Awaited<ReturnType<typeof listTaskRuns>>,
): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const run of runs) {
    for (const label of providerLabels(run.model_providers)) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

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
  let facets: Awaited<ReturnType<typeof fetchTaskViewConfigFacets>> = [];
  let error: string | null = null;
  let canDeleteRuns = false;

  try {
    // The scoped list is what renders, bounded to the newest
    // TASK_RUN_HISTORY_LIMIT rows. Facets feed the control menus and are
    // best-effort (a facets failure must not blank the run history). The
    // project read feeds the run-delete role gate (best-effort too).
    // The task lookup degrades only on not-found: inventory is replaced on
    // every source sync, so a renamed/moved/removed task must not hide the
    // run evidence that still exists for it. Any other failure propagates —
    // an unreachable backend must surface as an error, not as a false
    // "removed from catalog".
    const [resolved, scoped, facetResult, project] = await Promise.all([
      getProjectAgentTask(projectId, taskId).catch((error: unknown) =>
        isNotFoundStatus(error) ? null : Promise.reject(error),
      ),
      listTaskRuns(taskId, projectId, cohort, TASK_RUN_HISTORY_LIMIT),
      fetchTaskViewConfigFacets(projectId).catch(() => []),
      getProject(projectId).catch(() => null),
    ]);
    task = resolved;
    taskRuns = scoped;
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

  // Off-catalog task with no recorded runs — a genuine dead end.
  if (!task && taskRuns.length === 0) {
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
        <div className="mx-6 mt-4 rounded-md border border-border bg-card px-4 py-3 text-[13px] text-muted-foreground">
          Task not found in the project catalog, and no runs were recorded
          for it. It may have been removed or renamed in the task source.
        </div>
      </div>
    );
  }

  // Off-catalog task that still has run history — show the evidence.
  const inCatalog = task !== null;
  const displayName = task ? task.display_name : taskId;
  const fileCount = task ? (task.has_checks ? 1 : 0) + 1 : 0;

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
          <h1 className="min-w-0 truncate text-[20px] font-semibold tracking-tight">{displayName}</h1>
          {task ? (
            <Badge variant="outline" className="text-[10px]">{task.adapter_name}</Badge>
          ) : (
            <Badge variant="outline" className="text-[10px]">removed from catalog</Badge>
          )}
        </div>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
          {task ? (
            <>
              <Badge variant="outline" className="font-mono text-[10px]">{task.folder_path || "(root)"}</Badge>
              <Badge variant="outline" className="text-[10px]">{fileCount} files</Badge>
            </>
          ) : null}
          <Badge variant="outline" className="text-[10px]">
            {scopeActive
              ? taskRuns.length === TASK_RUN_HISTORY_LIMIT
                ? `${TASK_RUN_HISTORY_LIMIT}+ task runs in view (newest first)`
                : `${taskRuns.length} task runs in view`
              : taskRuns.length === TASK_RUN_HISTORY_LIMIT
                ? `${TASK_RUN_HISTORY_LIMIT}+ task runs (newest first)`
                : `${taskRuns.length} task runs`}
          </Badge>
        </div>
        {task && (task.description || provenanceLine(task)) && (
          <div className="mt-3 min-w-0">
            {task.description && (
              <p className="max-w-3xl text-[13px] leading-relaxed text-muted-foreground">{task.description}</p>
            )}
            <p className="mt-1 text-[12px] text-muted-foreground/60 font-mono">
              {provenanceLine(task)}
            </p>
          </div>
        )}
      </div>

      {!inCatalog ? (
        <div className="border-b border-warning/30 bg-warning/10 px-6 py-3 text-[13px] text-warning">
          This task is no longer in the project catalog (removed or renamed in
          the task source). Its recorded runs are shown below; task files are
          unavailable.
        </div>
      ) : null}

      {/* Run-history scope: the shared filter bar in its own strip, hosted the
          same way the Tasks and Runs pages host it. The bar reads the search
          params client-side, so it needs a Suspense boundary — without one,
          Next.js would force the whole page into client-side rendering. */}
      <div className="border-b border-border bg-muted/10 px-6 py-2.5">
        <Suspense fallback={null}>
          <RunHistoryScopeBar
            projectId={projectId}
            facets={facets}
            hostOptions={hostOptionsFromRuns(taskRuns)}
          />
        </Suspense>
      </div>

      <Tabs defaultValue="runs" className="flex flex-col">
        <div className="border-b border-border px-6">
          <TabsList className="h-10 bg-card">
            <TabsTrigger value="runs" className="px-4 text-[13px]">Task Run History</TabsTrigger>
            {inCatalog ? (
              <TabsTrigger value="files" className="px-4 text-[13px]">
                Files
                <Badge variant="outline" className="ml-1.5 text-[10px] px-1.5 py-0">
                  {fileCount}
                </Badge>
              </TabsTrigger>
            ) : null}
          </TabsList>
        </div>

        <TabsContent value="runs" className="mt-0">
          <TaskRunHistory runs={taskRuns} canDelete={canDeleteRuns} />
        </TabsContent>

        {inCatalog ? (
          <TabsContent value="files" className="mt-0 p-6">
            <TaskFileBrowser
              taskId={taskId}
              projectId={projectId}
            />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}

/**
 * The detail header's provenance line (issue #444): git authorship when the
 * publisher could see it (with the adding commit), first publication always.
 * Both halves are shown when both exist — they answer different questions
 * ("who wrote it" vs "who brought it to this project").
 */
function provenanceLine(task: AgentTaskDetail): string | null {
  const parts: string[] = [];
  if (task.git_author_name && task.git_first_commit_at) {
    const sha = task.git_first_commit_sha ? ` (${task.git_first_commit_sha.slice(0, 8)})` : "";
    parts.push(
      `Written by ${task.git_author_name} on ${isoDate(task.git_first_commit_at)}${sha}`,
    );
  }
  if (task.first_published_at) {
    const by = task.first_published_by ? ` by ${task.first_published_by}` : "";
    parts.push(`First published ${isoDate(task.first_published_at)}${by}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function isoDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}
