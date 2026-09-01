import Link from "next/link";
import { ArrowRight } from "lucide-react";

import {
  listAgentTaskBatchRuns,
  type AgentTaskBatchRunSummary,
} from "@/lib/agent-task-api";
import { apiClient } from "@/lib/api-client";

/**
 * Demo-forward landing for anonymous visitors: the demo
 * sells itself with real fixture numbers before asking anything. The cards
 * render from the demo project's aggregates — if the demo is disabled
 * (kill switch) or the backend is unreachable, we fall back to a plain
 * sign-in prompt instead of a broken showcase.
 */
export async function DemoLanding() {
  const stats = await loadDemoStats();

  return (
    <main className="min-h-screen bg-background px-6 py-16">
      <div className="mx-auto w-full max-w-3xl">
        <h1 className="text-[22px] font-semibold tracking-tight">
          See apo in action.
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A real workspace of captured agent runs — every failure with its
          evidence, every verdict with its judge.
        </p>

        {stats ? (
          <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard
              label="RUNS CAPTURED"
              value={String(stats.runCount)}
              hint={`${stats.batchCount} batches`}
            />
            <StatCard
              label="MODELS COMPARED"
              value={String(stats.modelCount)}
              hint="side by side, with evidence"
            />
            <StatCard
              label="CAPTURED"
              value={stats.capturedOn}
              hint="frozen example data"
            />
          </div>
        ) : null}

        <div className="mt-8 flex items-center gap-4">
          <Link
            href="/project/demo/tasks"
            className="inline-flex h-9 items-center gap-2 bg-foreground px-4 text-[13px] font-medium text-background hover:bg-foreground/90"
          >
            Explore the demo
            <ArrowRight className="size-4" />
          </Link>
          <Link
            href="/login"
            className="text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Sign in to run your own
          </Link>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          No account needed. Read-only.
        </p>
      </div>
    </main>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="border border-border bg-card p-4">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-xl font-semibold tabular-nums">
        {value}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>
    </div>
  );
}

type DemoStats = {
  runCount: number;
  batchCount: number;
  modelCount: number;
  capturedOn: string;
};

async function loadDemoStats(): Promise<DemoStats | null> {
  try {
    // Anonymous reads of the demo project ride the middleware's anonymous
    // credential — no session needed.
    const batches = await listAgentTaskBatchRuns("demo", { page_size: 100 });
    const rows: AgentTaskBatchRunSummary[] = batches.data ?? [];
    if (rows.length === 0) return null;
    const runCount = rows.reduce((sum, b) => sum + (b.total_tasks ?? 0), 0);
    const capturedOn = rows
      .flatMap((b) => {
        const stamp = b.completed_at ?? b.created_at;
        return stamp ? [stamp] : [];
      })
      .sort()
      .at(-1)!
      .slice(0, 10);
    let modelCount = 0;
    try {
      const facets = await apiClient<{ models?: string[] }>(
        "/v1/projects/demo/agent-task-run-config-facets",
      );
      modelCount = facets.models?.length ?? 0;
    } catch {
      modelCount = 0;
    }
    return { runCount, batchCount: rows.length, modelCount, capturedOn };
  } catch {
    // Kill switch, backend down, or demo empty: no cards, still a page.
    return null;
  }
}
