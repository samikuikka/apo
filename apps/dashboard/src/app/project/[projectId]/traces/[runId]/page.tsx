import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import { getTraceDetail, getAdjacentTraces, type TraceDetail } from "@/lib/traces-api";
import {
  UrlSelectionProvider,
  TraceWorkspacePage,
} from "@/components/trace-detail";

export const dynamic = "force-dynamic";

// Tab title: "Trace <short id>". Falls back to "Trace" on fetch failure.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string; runId: string }>;
}): Promise<Metadata> {
  const { projectId, runId } = await params;
  try {
    const detail = await getTraceDetail(runId, projectId);
    return { title: `Trace ${detail.run.id.slice(0, 8)}` };
  } catch {
    return { title: "Trace" };
  }
}

export default async function TraceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; runId: string }>;
  searchParams: Promise<{ sort_by?: string; sort_order?: string }>;
}) {
  const { projectId, runId } = await params;
  const { sort_by, sort_order } = await searchParams;
  let trace: TraceDetail | null = null;
  let error: string | null = null;

  try {
    trace = await getTraceDetail(runId, projectId);
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to fetch trace details";
  }

  if (error) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
          <p className="font-medium">Error</p>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!trace) {
    return null;
  }

  const adjacent = await getAdjacentTraces(runId, sort_by, sort_order, projectId);

  return (
    <div className="flex h-[calc(100vh-6rem)] flex-col overflow-hidden">
      {trace.run.task_run_id && (
        <Link
          href={`/project/${projectId}/runs/task/${trace.run.task_run_id}`}
          className="flex items-center gap-1.5 border-b border-border bg-muted/30 px-4 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Part of agent task run
          <span className="font-mono text-foreground">
            {trace.run.task_run_id.slice(0, 12)}
          </span>
        </Link>
      )}
      <Suspense>
        <UrlSelectionProvider runId={runId} projectId={projectId}>
          <TraceWorkspacePage
            run={trace}
            backHref={`/project/${projectId}/traces`}
            backLabel="Traces"
            adjacentPrevId={adjacent.prev_id}
            adjacentNextId={adjacent.next_id}
          />
        </UrlSelectionProvider>
      </Suspense>
    </div>
  );
}
