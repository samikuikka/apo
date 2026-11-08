"use client";

import { useReducer, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  createAgentTaskBatchRun,
  type AgentTaskSummary,
  type RunLabels,
} from "@/lib/agent-task-api";
import { createTaskViewComparison, type TaskViewConfig } from "@/lib/agent-task-view-api";
import {
  type ProjectTaskSource,
  syncProjectTaskSource,
} from "@/lib/projects-api";

type RunState = { running: boolean; error: string | null };
type RunAction =
  | { type: "START" }
  | { type: "SUCCESS" }
  | { type: "ERROR"; error: string };

function runReducer(s: RunState, a: RunAction): RunState {
  switch (a.type) {
    case "START": return { running: true, error: null };
    case "SUCCESS": return { running: false, error: null };
    case "ERROR": return { running: false, error: a.error };
  }
}

interface UseTaskRunActionsArgs {
  projectId: string;
  isDemoProject: boolean;
  taskSource: ProjectTaskSource | null;
  tasks: AgentTaskSummary[];
  selected: Set<string>;
  /** The active evidence view — side A of any comparison snapshot. */
  activeView: { model: string | null; effort: string | null; since: string | null };
}

/**
 * The toolbar's three async actions: source sync, batch run of the current
 * selection, and building a two-view comparison snapshot from it.
 */
export function useTaskRunActions({
  projectId,
  isDemoProject,
  taskSource,
  tasks,
  selected,
  activeView,
}: UseTaskRunActionsArgs) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [runState, dispatchRun] = useReducer(runReducer, { running: false, error: null });

  const handleSync = async () => {
    if (syncing || isDemoProject || !taskSource) return;
    setSyncing(true);
    try {
      await syncProjectTaskSource(projectId);
      toast.success("Task source synced");
      router.refresh();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const handleRun = async (labels?: RunLabels) => {
    if (selected.size === 0 || isDemoProject) return;
    dispatchRun({ type: "START" });
    const hasLabels = labels !== undefined && Object.keys(labels).length > 0;
    try {
      const selectedTasks = tasks.filter((t) => selected.has(t.id));
      const taskIds = selectedTasks.map((t) => t.id);
      const result = await createAgentTaskBatchRun({
        project: projectId,
        task_ids: taskIds,
        run_metadata: {
          trigger: {
            source: "dashboard",
            user_agent: typeof navigator === "undefined" ? null : navigator.userAgent,
            entrypoint: "/tasks",
            initiated_at: new Date().toISOString(),
          },
          // Labels ride in run_metadata only when set: the no-label request
          // stays byte-identical to the pre-labels one.
          ...(hasLabels ? { labels } : {}),
        },
      });
      window.location.href = `/project/${projectId}/runs/${result.id}`;
    } catch (e: unknown) {
      dispatchRun({ type: "ERROR", error: e instanceof Error ? e.message : "Failed to start batch run" });
    }
  };

  // Build an immutable snapshot of the selection under two
  // views and navigate to the comparison page. Side A = the active tab's view;
  // side B defaults to a contrasting model (the first one that differs), or to
  // Main if the active tab is already a model view with no alternative.
  const handleCompare = async (bModel: string | null) => {
    if (selected.size === 0 || isDemoProject) return;
    setComparing(true);
    try {
      const viewA: TaskViewConfig = { model: activeView.model, effort: activeView.effort, since: activeView.since };
      const viewB: TaskViewConfig = { model: bModel, effort: null, since: activeView.since };
      const snapshot = await createTaskViewComparison(projectId, {
        task_ids: [...selected],
        view_a: viewA,
        view_b: viewB,
      });
      router.push(`/project/${projectId}/compare-views/${snapshot.id}`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to build comparison");
    } finally {
      setComparing(false);
    }
  };

  return { syncing, handleSync, runState, handleRun, comparing, handleCompare };
}
