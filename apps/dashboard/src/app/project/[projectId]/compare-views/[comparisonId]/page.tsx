import { notFound } from "next/navigation";

import { listProjectAgentTasks, type AgentTaskSummary } from "@/lib/agent-task-api";
import {
  getTaskViewComparison,
  type TaskViewComparisonSnapshot,
} from "@/lib/agent-task-view-api";
import { CompareViewsClient } from "./compare-views-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Compare views" };

export default async function CompareViewsPage({
  params,
}: {
  params: Promise<{ projectId: string; comparisonId: string }>;
}) {
  const { projectId, comparisonId } = await params;

  // Snapshot ids are opaque ``tvc_`` tokens; a malformed id is a 404, not a 500.
  let snapshot: TaskViewComparisonSnapshot | null = null;
  try {
    snapshot = await getTaskViewComparison(projectId, comparisonId);
  } catch {
    notFound();
  }
  if (!snapshot) notFound();

  // Task names/folders for grouping. Historical tasks no longer in inventory
  // fall back to their raw id (the snapshot still references them).
  const inventory: AgentTaskSummary[] = await listProjectAgentTasks(projectId).catch(() => []);

  return (
    <CompareViewsClient
      projectId={projectId}
      snapshot={snapshot}
      tasks={inventory}
    />
  );
}
