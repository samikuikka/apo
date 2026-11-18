// PROTOTYPE · throwaway route, second round. Two variants of the suite-health
// surface (belief 9: surface tests that never fail), switched via
// ?health=0|A|B (arrow keys work too). ?data=demo swaps the real fetches for
// a deterministic fixture (see NOTES.md for the research that shaped round 2
// and the round-1 rejection). Delete once a variant wins.

import { redirect } from "next/navigation";
import { listAgentTaskBatchRuns } from "@/lib/agent-task-api";
import {
  PROTOTYPE_VARIANTS,
  buildHealthData,
  listProjectTaskRuns,
  type TaskHealth,
} from "./health-data";
import { buildDemoHealth } from "./health-fixture";
import PrototypeSwitcher from "./prototype-switcher";
import VariantAReview from "./variant-a-review";
import VariantBTasksEmbed from "./variant-b-tasks-embed";

export const dynamic = "force-dynamic";

export const metadata = { title: "Suite Health (prototype)" };

export default async function SuiteHealthPrototypePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  // Top-level throwaway route, deliberately outside the project layout's
  // auth guard, so the prototype opens in any browser with no login. Demo
  // data is computed locally; real-data mode needs a session and falls back
  // to the empty state without one.
  const projectId =
    typeof query.project === "string" && query.project
      ? query.project
      : "agent-demo";
  if (process.env.NODE_ENV === "production") {
    redirect(`/project/${projectId}/tasks`);
  }
  // ?health= (not ?variant=, ?monitor=, or ?trend=) · the shell, monitors, and
  // trends prototypes own those params.
  const raw = typeof query.health === "string" ? query.health.toUpperCase() : "A";
  const variant = PROTOTYPE_VARIANTS.some((v) => v.key === raw) ? raw : "A";
  const useDemo = query.data === "demo";

  let tasks: TaskHealth[] = [];
  if (useDemo) {
    tasks = buildDemoHealth();
  } else {
    try {
      const [batchRuns, taskRuns] = await Promise.all([
        listAgentTaskBatchRuns(projectId, { page_size: 100 }).then((p) => p.data),
        listProjectTaskRuns(projectId).catch(() => []),
      ]);
      tasks = buildHealthData(batchRuns, taskRuns);
    } catch {
      tasks = [];
    }
  }

  return (
    <main className="h-full overflow-y-auto">
      {variant === "A" ? (
        tasks.length > 0 ? (
          <VariantAReview projectId={projectId} tasks={tasks} demo={useDemo} />
        ) : (
          <EmptyState />
        )
      ) : variant === "B" ? (
        tasks.length > 0 ? (
          <VariantBTasksEmbed projectId={projectId} tasks={tasks} demo={useDemo} />
        ) : (
          <EmptyState />
        )
      ) : (
        <div className="mx-auto max-w-6xl px-6 py-6">
          <h1 className="text-[18px] font-semibold tracking-tight">Suite Health</h1>
          <p className="mt-2 max-w-2xl text-xs text-muted-foreground">
            Original: nothing today. Every test that passes forever reads as
            green, and no surface ever says so. Flip variants with the bar below
            or ←/→.
          </p>
        </div>
      )}
      <PrototypeSwitcher current={variant} dataMode={useDemo ? "demo" : "real"} />
    </main>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <h1 className="text-[18px] font-semibold tracking-tight">Suite Health</h1>
      <p className="mt-2 max-w-2xl text-xs text-muted-foreground">
        No task runs in this project yet. Flip the bar&apos;s Data toggle to
        Demo to see the surface at suite scale.
      </p>
    </div>
  );
}
