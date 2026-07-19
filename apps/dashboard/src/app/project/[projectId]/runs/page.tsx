import {
  listAgentTaskBatchRuns,
  type AgentTaskBatchRunSummary,
} from "@/lib/agent-task-api";
import { getProject, type ProjectTaskSource } from "@/lib/projects-api";
import { Suspense } from "react";
import { RunsClient } from "./runs-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Runs" };

export default async function RunsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  let batchRuns: AgentTaskBatchRunSummary[] = [];
  let error: string | null = null;
  let taskSource: ProjectTaskSource | null = null;

  try {
    batchRuns = await listAgentTaskBatchRuns(projectId);
    try {
      const project = await getProject(projectId);
      taskSource = project.task_source;
    } catch {
      // Non-fatal: source awareness is a progressive enhancement.
    }
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to fetch runs";
  }

  return (
    <main className="h-full flex flex-col">
      <Suspense>
        <RunsClient batchRuns={batchRuns} error={error} taskSource={taskSource} />
      </Suspense>
    </main>
  );
}
