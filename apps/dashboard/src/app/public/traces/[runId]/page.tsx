import { Suspense } from "react";
import type { Metadata } from "next";
import { getPublicTrace, type TraceDetail } from "@/lib/traces-api";
import { UrlSelectionProvider, TraceWorkspace } from "@/components/trace-detail";
import { PublicTraceHeader } from "./public-trace-header";

export const dynamic = "force-dynamic";

// Tab title: "Public trace <short id>". Falls back to "Public trace" on
// fetch failure or when the trace is no longer public.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ runId: string }>;
}): Promise<Metadata> {
  const { runId } = await params;
  try {
    const trace = await getPublicTrace(runId);
    return {
      title: trace ? `Public trace ${trace.run.id.slice(0, 8)}` : "Public trace",
    };
  } catch {
    return { title: "Public trace" };
  }
}

export default async function PublicTracePage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  let trace: TraceDetail | null = null;
  let error: string | null = null;

  try {
    trace = await getPublicTrace(runId);
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to fetch trace details";
  }

  if (error) {
    return (
      <PublicTraceError
        message={error}
        hint="The trace may have been made private, or the server is unreachable."
      />
    );
  }

  if (!trace) {
    return (
      <PublicTraceError
        message="This trace is not public."
        hint="The owner may have set it back to private, or the link is incorrect."
      />
    );
  }

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden">
      <PublicTraceHeader />
      <div className="min-h-0 flex-1">
        <Suspense>
          <UrlSelectionProvider runId={runId}>
            <TraceWorkspace run={trace} mode="page" readOnly className="h-full" />
          </UrlSelectionProvider>
        </Suspense>
      </div>
    </div>
  );
}

function PublicTraceError({ message, hint }: { message: string; hint: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="mx-auto max-w-md space-y-2 border border-border/70 bg-muted/20 p-6 text-center">
        <p className="text-sm font-medium text-foreground">{message}</p>
        <p className="text-[13px] text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}
