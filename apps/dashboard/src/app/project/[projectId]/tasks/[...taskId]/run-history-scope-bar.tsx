"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FilterBar } from "@/components/filter-bar";
import { fetchSavedViews } from "@/lib/agent-task-view-api";
import type { RunConfigModelFacet } from "@/lib/agent-task-view-api";
import { TASK_RUN_STATUS_FILTERS } from "@/lib/filter-status";
import { parseRunCohort, type RunCohort } from "@/lib/run-cohort";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * The task detail page's run-history scope — the shared FilterBar over this
 * page's run-level status vocabulary.
 *
 * The URL is the source of truth: the bar reads `?model=&effort=&since=&status=&view=`,
 * and every control change replaces the search params (never pushes — back must
 * leave the task page, not step through filter states). Status is comma-joined
 * (`?status=passed,error`), the same encoding every other multi-value
 * dimension uses; repeated params from old links still parse. The `view`
 * param is informational only: it names the saved view the user arrived from
 * and hides itself once the scope diverges from that view.
 */

export interface TaskRunHistoryScope extends RunCohort {
  status: Set<string>;
}

export function TaskRunHistoryControls({
  scope,
  facets,
  viewLabel,
  onScopeChange,
  onReset,
}: {
  scope: TaskRunHistoryScope;
  facets: RunConfigModelFacet[];
  viewLabel: string | null;
  onScopeChange: (next: Partial<TaskRunHistoryScope>) => void;
  onReset: () => void;
}) {
  const effortTiers = facets.find((f) => f.model === scope.model)?.efforts ?? [];

  return (
    <FilterBar
      statusOptions={TASK_RUN_STATUS_FILTERS}
      status={scope.status}
      onStatusChange={(status) => onScopeChange({ status })}
      modelOptions={facets}
      selectedModels={scope.model ? new Set([scope.model]) : new Set()}
      onSelectModel={(model) => onScopeChange({ model, effort: null })}
      effortOptions={
        effortTiers.length >= 2
          ? effortTiers.map((tier) => ({ value: tier.effort, label: tier.effort }))
          : []
      }
      effort={scope.effort}
      onEffortChange={(effort) => onScopeChange({ effort })}
      since={scope.since}
      onSinceChange={(since) => onScopeChange({ since })}
      onClearAll={onReset}
      trailing={
        <>
          {viewLabel && (
            <span className="text-[11px] text-muted-foreground">{`scoped to view: ${viewLabel}`}</span>
          )}
          <button
            type="button"
            onClick={onReset}
            className="text-[11px] text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            All history
          </button>
        </>
      }
    />
  );
}

interface SavedViewShape {
  id: string;
  label: string;
  model: string | null;
  effort: string | null;
  since: string | null;
}

/** Parse `?status=` accepting both the comma-joined and repeated encodings. */
function parseStatusParam(searchParams: URLSearchParams): Set<string> {
  const values: string[] = [];
  for (const raw of searchParams.getAll("status")) {
    for (const part of raw.split(",")) {
      const value = part.trim();
      if (value) values.push(value);
    }
  }
  return new Set(values);
}

export function RunHistoryScopeBar({
  projectId,
  facets,
}: {
  projectId: string;
  facets: RunConfigModelFacet[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const viewId = searchParams.get("view");
  const scope = useMemo<TaskRunHistoryScope>(() => {
    const cohort = parseRunCohort(Object.fromEntries(searchParams.entries()));
    return { ...cohort, status: parseStatusParam(searchParams) };
  }, [searchParams]);

  const [view, setView] = useState<SavedViewShape | null>(null);
  useEffect(() => {
    if (!viewId) {
      setView(null);
      return;
    }
    let cancelled = false;
    fetchSavedViews(projectId)
      .then((views) => {
        if (cancelled) return;
        setView(views.find((v) => v.id === viewId) ?? null);
      })
      .catch(() => {
        if (!cancelled) setView(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, viewId]);

  // The chip disappears once the scope no longer matches the view it names.
  const viewLabel =
    view &&
    view.model === scope.model &&
    view.effort === scope.effort &&
    view.since === scope.since
      ? view.label
      : null;

  const writeParams = useCallback(
    (next: TaskRunHistoryScope, keepView: boolean) => {
      const params = new URLSearchParams();
      if (next.model) params.set("model", next.model);
      if (next.effort) params.set("effort", next.effort);
      if (next.since) params.set("since", next.since);
      if (next.status.size > 0) {
        params.set("status", Array.from(next.status).join(","));
      }
      if (keepView && viewId) params.set("view", viewId);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname, viewId],
  );

  const merged = useCallback(
    (patch: Partial<TaskRunHistoryScope>): TaskRunHistoryScope => ({
      model: patch.model !== undefined ? patch.model : scope.model,
      effort: patch.effort !== undefined ? patch.effort : scope.effort,
      since: patch.since !== undefined ? patch.since : scope.since,
      status: patch.status !== undefined ? patch.status : scope.status,
    }),
    [scope],
  );

  // Status picks are mirrored locally and committed to the URL debounced:
  // every URL write is a server round-trip that remounts the page (closing
  // the menu mid-selection), so a burst of checkbox picks must land as one
  // navigation. External ?status changes (back/forward) re-sync the mirror
  // during render via a prev-value compare; our own committed writes sync it
  // to the same value, so there is no loop.
  const statusKey = Array.from(scope.status).sort().join(",");
  const [statusMirror, setStatusMirror] = useState(scope.status);
  const [prevStatusKey, setPrevStatusKey] = useState(statusKey);
  if (statusKey !== prevStatusKey) {
    setPrevStatusKey(statusKey);
    setStatusMirror(new Set(scope.status));
  }
  const statusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleScopeChange = useCallback(
    (patch: Partial<TaskRunHistoryScope>) => {
      const statusOnly =
        patch.status !== undefined &&
        patch.model === undefined &&
        patch.effort === undefined &&
        patch.since === undefined;
      if (statusOnly && patch.status) {
        setStatusMirror(patch.status);
        const next = patch.status;
        clearTimeout(statusTimer.current);
        statusTimer.current = setTimeout(() => {
          writeParams({ ...scope, status: next }, true);
        }, 300);
        return;
      }
      // Any other dimension commits immediately, flushing a pending status
      // selection along (dropping it would silently undo the user's picks).
      clearTimeout(statusTimer.current);
      writeParams(merged({ ...patch, status: patch.status ?? statusMirror }), true);
    },
    [scope, merged, writeParams, statusMirror],
  );

  return (
    <TaskRunHistoryControls
      scope={{ ...scope, status: statusMirror }}
      facets={facets}
      viewLabel={viewLabel}
      onScopeChange={handleScopeChange}
      onReset={() => {
        clearTimeout(statusTimer.current);
        setStatusMirror(new Set());
        writeParams({ ...scope, model: null, effort: null, since: null, status: new Set() }, true);
      }}
    />
  );
}
