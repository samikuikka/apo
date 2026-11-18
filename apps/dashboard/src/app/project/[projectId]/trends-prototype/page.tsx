// PROTOTYPE · throwaway route. Five variants of a run-evolution ("trends")
// view over the project's real batch + task runs, switched via
// ?trend=0|A|B|C|D|E (arrow keys work too; E also reads ?base=/?cand= batch
// run ids). ?data=demo swaps both fetches for a deterministic suite-scale
// fixture (see NOTES.md "Demo dataset"). Delete once a variant wins.

import { redirect } from "next/navigation";
import {
  listAgentTaskBatchRuns,
  type AgentTaskRunSummary,
} from "@/lib/agent-task-api";
import {
  PROTOTYPE_VARIANTS,
  buildTaskFlips,
  buildTaskMatrix,
  buildTrendData,
  latestTaskResults,
  listProjectTaskRuns,
  type TrendPoint,
} from "./trends-data";
import { buildDemoData } from "./trends-fixture";
import PrototypeSwitcher from "./prototype-switcher";
import VariantAChecks from "./variant-a-checks";
import VariantBMatrix from "./variant-b-matrix";
import VariantCStrips from "./variant-c-strips";
import VariantDFlips from "./variant-d-flips";
import VariantERunDiff from "./variant-e-diff";
import VariantFFoundry from "./variant-f-foundry";

export const dynamic = "force-dynamic";

export const metadata = { title: "Run Trends (prototype)" };

export default async function TrendsPrototypePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  if (process.env.NODE_ENV === "production") {
    redirect(`/project/${projectId}/runs`);
  }
  // ?trend= (not ?variant= or ?monitor=) · the shell and monitors
  // prototypes own those params.
  const raw = typeof query.trend === "string" ? query.trend.toUpperCase() : "A";
  const variant = PROTOTYPE_VARIANTS.some((v) => v.key === raw) ? raw : "A";
  // ?data=demo · deterministic fixture instead of the two real fetches.
  const useDemo = query.data === "demo";

  let points: TrendPoint[] = [];
  let taskRuns: AgentTaskRunSummary[] = [];
  if (useDemo) {
    ({ points, taskRuns } = buildDemoData());
  } else {
    try {
      const [batchRuns, batchTaskRuns] = await Promise.all([
        listAgentTaskBatchRuns(projectId, { page_size: 100 }).then((p) => p.data),
        listProjectTaskRuns(projectId).catch(() => [] as AgentTaskRunSummary[]),
      ]);
      points = buildTrendData(batchRuns, batchTaskRuns);
      taskRuns = batchTaskRuns;
    } catch {
      points = [];
    }
  }

  const matrix = buildTaskMatrix(points, taskRuns);
  const flips = buildTaskFlips(points, taskRuns);

  return (
    <main className="h-full overflow-y-auto">
      {points.length === 0 ? (
        <div className="mx-auto max-w-6xl p-6">
          <h1 className="text-[18px] font-semibold tracking-tight">
            Run Trends
          </h1>
          <p className="mt-2 text-xs text-muted-foreground">
            No completed runs in this project yet.
          </p>
        </div>
      ) : variant === "A" ? (
        <VariantAChecks projectId={projectId} points={points} />
      ) : variant === "B" ? (
        <VariantBMatrix
          projectId={projectId}
          columns={matrix.columns}
          rows={matrix.rows}
        />
      ) : variant === "C" ? (
        <VariantCStrips
          points={points}
          taskResults={latestTaskResults(points, taskRuns)}
        />
      ) : variant === "D" ? (
        <VariantDFlips
          projectId={projectId}
          flips={flips}
          windowSize={points.length}
        />
      ) : variant === "E" ? (
        <VariantERunDiff
          projectId={projectId}
          points={points}
          taskRuns={taskRuns}
          baseParam={typeof query.base === "string" ? query.base : undefined}
          candParam={typeof query.cand === "string" ? query.cand : undefined}
        />
      ) : variant === "F" ? (
        <VariantFFoundry
          projectId={projectId}
          points={points}
          taskResults={latestTaskResults(points, taskRuns)}
        />
      ) : (
        <div className="mx-auto max-w-6xl p-6">
          <h1 className="text-[18px] font-semibold tracking-tight">
            Run Trends
          </h1>
          <p className="mt-2 text-xs text-muted-foreground">
            Original: no trends view today. Flip variants with the bar below
            or ←/→.
          </p>
        </div>
      )}
      <PrototypeSwitcher
        current={variant}
        dataMode={useDemo ? "demo" : "real"}
      />
    </main>
  );
}
