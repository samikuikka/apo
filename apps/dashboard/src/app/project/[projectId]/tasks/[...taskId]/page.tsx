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

// Tab title: "Task: <display_name>". Mirrors the page's task-resolution logic
// (demo / inventory / legacy) so the title matches what the page renders.
// Falls back to "Task" on any failure.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string; taskId: string[] }>;
}): Promise<Metadata> {
  const { projectId, taskId: taskIdSegments } = await params;
  const taskId = joinTaskId(taskIdSegments);
  const isDemo = projectId === DEMO_PROJECT;
  try {
    if (isDemo) {
      const task = await getAgentTask(taskId, TASK_ROOT, projectId);
      return { title: `Task: ${task.display_name}` };
    }
    try {
      const project = await getProject(projectId);
      if (project.task_source !== null && !project.task_source.inventory_stale) {
        const task = await getProjectAgentTask(projectId, taskId);
        return { title: `Task: ${task.display_name}` };
      }
    } catch {
      // fall through to legacy
    }
    const task = await getAgentTask(taskId, TASK_ROOT, projectId);
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
  searchParams: Promise<{ task_root?: string }>;
}) {
  const [{ projectId, taskId: taskIdSegments }, { task_root }] = await Promise.all([params, searchParams]);
  const taskId = joinTaskId(taskIdSegments);
  const taskRoot = task_root ?? TASK_ROOT;
  const isDemo = projectId === DEMO_PROJECT;

  // Resolve task source so we can pick between the SPEC-119
  // inventory-backed endpoint (canonical for configured non-demo
  // projects) and the legacy discovery endpoint (demo + unconfigured).
  let useInventory = false;
  try {
    const project = await getProject(projectId);
    useInventory =
      !isDemo &&
      project.task_source !== null &&
      !project.task_source.inventory_stale;
  } catch {
    // Project fetch failure → fall back to legacy discovery; the actual
    // task fetch below will surface the canonical error if any.
  }

  let task: Awaited<ReturnType<typeof getProjectAgentTask>> | null = null;
  let taskRuns = EMPTY_TASK_RUNS;
  let error: string | null = null;

  async function fetchTask(): Promise<typeof task> {
    if (isDemo) {
      return getAgentTask(taskId, taskRoot, projectId);
    }
    // For non-demo projects, try the project-scoped inventory endpoint
    // first (canonical path). If that fails (project not configured,
    // inventory stale, auth hiccup in SSR), fall back to the legacy
    // discovery endpoint so the page doesn't go blank.
    if (useInventory) {
      try {
        return await getProjectAgentTask(projectId, taskId);
      } catch {
        // fall through to legacy
      }
    }
    return getAgentTask(taskId, taskRoot, projectId);
  }

  try {
    [task, taskRuns] = await Promise.all([
      fetchTask(),
      listTaskRuns(taskId, projectId),
    ]);
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to fetch task details";
  }

  if (error) {
    return (
      <div className="mx-6 mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
        {error}
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
