// PROTOTYPE — throwaway route. Three variants of a respan-inspired Monitors
// page, switchable via ?monitor=A|B|C (arrow keys work too). Everything is
// read-only; monitor fixtures are grounded in the project's real batch runs.
// See NOTES.md; delete this directory once a variant wins.

import {
  listAgentTaskBatchRuns,
  type AgentTaskBatchRunSummary,
} from "@/lib/agent-task-api";
import {
  PROTOTYPE_VARIANTS,
  buildPrototypeMonitors,
  projectSnapshot,
} from "./monitors-data";
import PrototypeSwitcher from "./prototype-switcher";
import VariantABuilder from "./variant-a-builder";
import VariantBBoard from "./variant-b-board";
import VariantCInbox from "./variant-c-inbox";

export const dynamic = "force-dynamic";

export const metadata = { title: "Automations (prototype)" };

export default async function MonitorsPrototypePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  // ?monitor= (not ?variant=) — the shell's status-bar prototype owns that one.
  const raw =
    typeof query.monitor === "string" ? query.monitor.toUpperCase() : "A";
  const variant = PROTOTYPE_VARIANTS.some((v) => v.key === raw) ? raw : "A";

  let batchRuns: AgentTaskBatchRunSummary[] = [];
  try {
    batchRuns = (
      await listAgentTaskBatchRuns(projectId, { page_size: 60 })
    ).data;
  } catch {
    batchRuns = [];
  }

  const monitors = buildPrototypeMonitors(projectId, batchRuns);
  const snapshot = projectSnapshot(batchRuns);

  return (
    <main className="h-full overflow-y-auto">
      {variant === "A" ? (
        <VariantABuilder
          projectId={projectId}
          monitors={monitors}
          snapshot={snapshot}
        />
      ) : variant === "B" ? (
        <VariantBBoard monitors={monitors} />
      ) : (
        <VariantCInbox projectId={projectId} monitors={monitors} />
      )}
      <PrototypeSwitcher current={variant} />
    </main>
  );
}
