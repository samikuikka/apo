import {
  getAgentTask,
  getProjectAgentTask,
  listTaskRuns,
} from "@/lib/agent-task-api";
import { getProject } from "@/lib/projects-api";
import { DEMO_PROJECT } from "@/lib/project-router";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TaskFileBrowser } from "@/components/agent-task-files/task-file-browser";
import { TaskRunHistory } from "./task-run-history";
import Link from "next/link";
import type { Metadata } from "next";
import { FolderOpen } from "lucide-react";

export const dynamic = "force-dynamic";

const TASK_ROOT = process.env.NEXT_PUBLIC_AGENT_TASK_ROOT ?? null;

// The route is a catch-all (`tasks/[...taskId]`) because task ids are
// hierarchical paths with slashes (e.g. "openai-agent/data-extraction").
// Join the captured segments back into the slash-delimited id the API expects.
const joinTaskId = (segments: string[]): string => segments.join("/");

// Tab title: "Task: <display_name>". Mirrors the page's task-resolution
// logic (see `resolveTask` below) so the title matches what the page
// renders. Falls back to "Task" on any failure.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string; taskId: string[] }>;
}): Promise<Metadata> {
  const { projectId, taskId: taskIdSegments } = await params;
  const taskId = joinTaskId(taskIdSegments);
  const isDemo = projectId === DEMO_PROJECT;
  try {
    const { task } = await resolveTask(projectId, taskId, TASK_ROOT, isDemo);
    return { title: `Task: ${task.display_name}` };
  } catch {
    return { title: "Task" };
  }
}

const EMPTY_TASK_RUNS: Awaited<ReturnType<typeof listTaskRuns>> = [];

/**
 * Resolve a task to display, shared by the page and its metadata.
 *
 * Resolution order matters and is the whole reason this helper exists:
 *
 * 1. **Demo project** → legacy filesystem discovery
 *    (`getAgentTask`). The demo workspace is intentionally read-only and
 *    not backed by the SPEC-119 inventory sync state machine.
 *
 * 2. **Non-demo project** → the project-scoped inventory endpoint
 *    (`getProjectAgentTask`) is canonical and the *first* thing tried.
 *    This is the fix for the "Task not found" navigation bug: the
 *    previous logic gated the inventory call on an SSR `getProject()`
 *    fetch, and when that fetch hiccuped the page silently fell through
 *    to legacy discovery against `NEXT_PUBLIC_AGENT_TASK_ROOT` — a local
 *    env var that frequently points at a stale or empty path, producing
 *    a spurious "Task not found" even when the inventory has the row.
 *
 * 3. **Legacy fallback** — only reached when the inventory endpoint
 *    fails *and* the project actually has a configured, non-stale
 *    source (so the missing row is a real absence, not a config gap).
 *    Unconfigured projects never fall through: the inventory 404 is the
 *    truth. We rethrow the inventory endpoint's error (e.g. "Task not
 *    found in inventory.") when there is nothing to fall back to, so
 *    the user sees the meaningful reason instead of "Task not found".
 */
async function resolveTask(
  projectId: string,
  taskId: string,
  taskRoot: string | null,
  isDemo: boolean,
): Promise<{ task: Awaited<ReturnType<typeof getProjectAgentTask>>; useInventory: boolean }> {
  if (isDemo) {
    // Demo workspace: legacy filesystem discovery only.
    return { task: await getAgentTask(taskId, taskRoot, projectId), useInventory: false };
  }

  // Canonical path first. Capture the error so we can either fall back
  // (when the project genuinely has a source) or rethrow it (when it
  // doesn't, meaning the 404 is the real answer).
  let inventoryError: unknown = null;
  try {
    return { task: await getProjectAgentTask(projectId, taskId), useInventory: true };
  } catch (e) {
    inventoryError = e;
  }

  // Only consider the legacy filesystem scan a valid fallback when the
  // project has a configured, non-stale task source — i.e. the row is
  // genuinely absent rather than the project being unconfigured. An
  // unconfigured project has no `TASK_ROOT` worth scanning anyway.
  try {
    const project = await getProject(projectId);
    const hasSource =
      project.task_source !== null && !project.task_source.inventory_stale;
    if (!hasSource) throw inventoryError;
  } catch {
    // Project fetch failure (e.g. transient SSR auth) — the inventory
    // endpoint's error is the most informative thing we can surface.
    throw inventoryError;
  }

  const task = await getAgentTask(taskId, taskRoot, projectId);
  return { task, useInventory: false };
}

export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; taskId: string[] }>;
  searchParams: Promise<{ task_root?: string }>;
}) {
  const [{ projectId, taskId: taskIdSegments }, { task_root }] = await Promise.all([params, searchParams]);
  const taskId = joinTaskId(taskIdSegments);
  const taskRoot = task_root ?? TASK_ROOT;
  const isDemo = projectId === DEMO_PROJECT;

  let task: Awaited<ReturnType<typeof getProjectAgentTask>> | null = null;
  let taskRuns = EMPTY_TASK_RUNS;
  let error: string | null = null;
  // Whether the task came from the inventory endpoint — the Files tab
  // needs this to pick the right file-listing route.
  let useInventory = false;

  try {
    const [resolved, runs] = await Promise.all([
      resolveTask(projectId, taskId, taskRoot, isDemo),
      listTaskRuns(taskId, projectId),
    ]);
    task = resolved.task;
    taskRuns = runs;
    useInventory = resolved.useInventory;
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

  const fileCount = (task.has_checks ? 1 : 0) +
    (task.has_user_simulator ? 1 : 0) + 1;

  return (
    <div className="mx-auto w-full max-w-6xl flex flex-col">
      {/* Page header */}
      <div className="border-b border-border px-6 py-5">
        <Link
          href={`/project/${projectId}/tasks`}
          className="text-[12px] text-muted-foreground hover:text-foreground"
        >
          &larr; Tasks
        </Link>
        <div className="mt-1 flex items-center gap-3">
          <FolderOpen className="h-4 w-4 text-primary" />
          <h1 className="text-[20px] font-semibold tracking-tight">{task.display_name}</h1>
          <Badge variant="outline" className="text-[10px]">{task.adapter_name}</Badge>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-mono text-[10px]">{task.folder_path || "(root)"}</Badge>
          <Badge variant="outline" className="text-[10px]">{fileCount} files</Badge>
          <Badge variant="outline" className="text-[10px]">{taskRuns.length} task runs</Badge>
        </div>

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
          <TaskRunHistory runs={taskRuns} />
        </TabsContent>

        <TabsContent value="files" className="mt-0 p-6">
          <TaskFileBrowser
            taskId={taskId}
            taskRoot={taskRoot}
            projectId={useInventory ? projectId : null}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
