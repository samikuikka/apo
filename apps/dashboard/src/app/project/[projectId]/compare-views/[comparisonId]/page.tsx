import { notFound } from "next/navigation";

import {
  listProjectAgentTasks,
  type AgentTaskRunDetail,
  type AgentTaskSummary,
} from "@/lib/agent-task-api";
import {
  getTaskViewComparisonEvidence,
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

  // Keep run evidence to one bounded backend request regardless of comparison
  // size; the independent task inventory read runs alongside it.
  const [evidence, inventory] = await Promise.all([
    getTaskViewComparisonEvidence(projectId, comparisonId).catch(() => notFound()),
    listProjectAgentTasks(projectId).catch(() => [] as AgentTaskSummary[]),
  ]);
  const { snapshot } = evidence;
  const runMap = new Map<string, AgentTaskRunDetail>(
    evidence.runs.map((run) => [run.id, run]),
  );
  const leftRuns = snapshot.resolved
    .map((cell) => (cell.a_run_id ? runMap.get(cell.a_run_id) : undefined))
    .filter((r): r is AgentTaskRunDetail => r !== undefined);
  const rightRuns = snapshot.resolved
    .map((cell) => (cell.b_run_id ? runMap.get(cell.b_run_id) : undefined))
    .filter((r): r is AgentTaskRunDetail => r !== undefined);
  const comparability = new Map(
    snapshot.resolved.map((cell) => [cell.task_id, cell.comparable]),
  );

  return (
    <CompareViewsClient
      projectId={projectId}
      snapshot={snapshot}
      tasks={inventory}
      leftRuns={leftRuns}
      rightRuns={rightRuns}
      comparability={comparability}
    />
  );
}
