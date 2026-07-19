"use client";

import { Suspense, useEffect } from "react";

/**
 * TracesPageClient - Client component for the canonical traces page.
 *
 * Provides the SelectionProvider and renders:
 * - Page-level layout (Filters + Table)
 * - Trace panel overlay (slides in when a trace is selected)
 *
 * Which trace is open in the side panel is synced to ?trace= so the panel
 * survives refresh and is shareable. The within-panel selection (call/view/tab)
 * is handled separately by the workspace.
 */

import { SelectionProvider, useSelection } from "@/components/trace-detail";
import { TracesPageLayout } from "@/components/trace-detail";
import type { TraceFilterOptions } from "@/components/trace-filter-controls";
import { TracePanel } from "@/components/trace-detail/TracePanel";
import type { TraceSummary, TraceSessionSummary } from "@/lib/traces-api";
import { useUrlParam } from "@/hooks/use-url-state";
import { TracesTablePanel } from "./TracesTablePanel";
import { SessionsTablePanel } from "./SessionsTablePanel";

interface PaginationData {
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface TracesPageClientProps {
  projectId: string;
  traces: TraceSummary[];
  error?: string | null;
  pagination?: PaginationData;
  filterOptions?: TraceFilterOptions;
  sessions?: TraceSessionSummary[];
  sessionsPagination?: PaginationData;
  view?: string;
}

/**
 * Bridges the side-panel selection to ?trace= in the URL. Reads once on mount
 * (so a shared link opens the panel) and writes back whenever the user picks a
 * different trace or closes the panel. Lives inside the SelectionProvider.
 */
function TraceSelectionUrlSync() {
  const { selectedRunId, selectRun } = useSelection();
  const [traceParam, setTraceParam] = useUrlParam("trace");

  // On mount: a shared ?trace= opens the panel.
  useEffect(() => {
    if (traceParam && traceParam !== selectedRunId) {
      selectRun(traceParam);
    }
    // Intentionally run only on mount — subsequent changes flow through the
    // effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the user opens/closes a trace, mirror it into the URL.
  useEffect(() => {
    setTraceParam(selectedRunId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId]);

  return null;
}

export function TracesPageClient({
  projectId,
  traces,
  error,
  pagination,
  filterOptions,
  sessions,
  sessionsPagination,
  view = "list",
}: TracesPageClientProps) {
  return (
    <SelectionProvider projectId={projectId}>
      <Suspense fallback={null}>
        <TraceSelectionUrlSync />
      </Suspense>
      <div className="relative h-full w-full">
        <TracesPageLayout filterOptions={filterOptions}>
          {view === "sessions" && sessions ? (
            <Suspense fallback={null}>
              <SessionsTablePanel
                sessions={sessions}
                pagination={sessionsPagination}
                onSelectSession={(sessionId) => {
                  const params = new URLSearchParams(window.location.search);
                  params.set("session_id", sessionId);
                  params.delete("view");
                  window.location.href = `/project/${projectId}/traces?${params.toString()}`;
                }}
              />
            </Suspense>
          ) : (
            <Suspense fallback={null}>
              <TracesTablePanel
                projectId={projectId}
                traces={traces}
                error={error}
                pagination={pagination}
              />
            </Suspense>
          )}
        </TracesPageLayout>

        <TracePanel />
      </div>
    </SelectionProvider>
  );
}
