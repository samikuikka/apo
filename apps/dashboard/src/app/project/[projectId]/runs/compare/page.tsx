import { Suspense } from "react";

import {
  getAgentTaskBatchRun,
  listProjectAgentTasks,
  type AgentTaskBatchRunDetail,
  type AgentTaskRunSummary,
  type AgentTaskSummary,
} from "@/lib/agent-task-api";
import { CompareClient } from "./compare-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Compare runs" };

async function resolveBatch(
  id: string | null,
): Promise<AgentTaskBatchRunDetail | null> {
  if (!id) return null;
  try {
    return await getAgentTaskBatchRun(id);
  } catch {
    // A bad/expired id renders as "not found" in the picker, not a crash.
    return null;
  }
}

export default async function ComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const query = await searchParams;
  const a = typeof query.a === "string" ? query.a : null;
  const b = typeof query.b === "string" ? query.b : null;

  const [batchA, batchB, inventory] = await Promise.all([
    resolveBatch(a),
    resolveBatch(b),
    listProjectAgentTasks(projectId).catch(() => [] as AgentTaskSummary[]),
  ]);

  return (
    <main className="h-full flex flex-col">
      <Suspense>
        <CompareClient
          projectId={projectId}
          batchA={batchA}
          batchB={batchB}
          inventory={inventory}
          leftRuns={batchA?.task_runs ?? ([] as AgentTaskRunSummary[])}
          rightRuns={batchB?.task_runs ?? ([] as AgentTaskRunSummary[])}
        />
      </Suspense>
    </main>
  );
}
