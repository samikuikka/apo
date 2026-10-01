"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { History } from "lucide-react";
import {
  type AgentTaskBatchRunSummary,
  type ModelFacetOption,
} from "@/lib/agent-task-api";
import { type ProjectTaskSource } from "@/lib/projects-api";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { useProjectId } from "@/lib/project-router";
import { useClientNow } from "@/hooks/use-client-now";
import { BATCH_RUN_STATUS_FILTERS } from "@/lib/filter-status";
import { RunsModelFilter, type ModelOption } from "./runs-model-filter";
import { RunsHostFilter } from "./runs-host-filter";
import type { ProviderFacetOption } from "@/lib/agent-task-api";
import { RunsCompareBar } from "./components/RunsCompareBar";
import { ListPagination } from "@/components/table";
import { RunsListAutoRefresh } from "@/components/agent-task-execution/runs-list-auto-refresh";
import { RunsRow } from "./components/RunsRow";
import { RunsToolbar } from "./components/RunsToolbar";
import { COL, computeOverlap } from "./components/runs-utils";
import { setModelArchived } from "@/lib/agent-task-view-api";
import { toast } from "sonner";

export function RunsClient({
  batchRuns,
  error: _error,
  taskSource,
  totalCount,
  page,
  pageSize,
  totalPages,
  modelFacets,
  providerFacets = [],
  canDeleteRuns,
}: {
  batchRuns: AgentTaskBatchRunSummary[];
  error: string | null;
  taskSource: ProjectTaskSource | null;
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  modelFacets: ModelFacetOption[];
  /** Serving-host facet for the Hosts column filter (issue #307). */
  providerFacets: ProviderFacetOption[];
  /** Caller's project role allows run deletion (owner/admin). */
  canDeleteRuns: boolean;
}) {
  const projectId = useProjectId();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const clientNow = useClientNow();
  const sourceUnconfigured = taskSource === null && totalCount === 0;

  const updateUrl = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  // Toolbar filter values, all derived from the URL the parent owns.
  const urlQ = searchParams.get("q") ?? "";
  const urlSince = searchParams.get("since");

  // Comma-joined multi-status (`?status=failed,error`), same encoding as
  // model/effort; the backend ORs the values.
  const statusParam = searchParams.get("status") ?? "";
  const selectedStatuses = useMemo(
    () => new Set(statusParam.split(",").filter(Boolean)),
    [statusParam],
  );
  // Status writes are mirrored locally and committed to the URL debounced:
  // every URL write is a server round-trip that remounts the page (closing
  // the menu mid-selection), so a burst of checkbox picks must land as one
  // navigation, not one per click. External ?status changes (back/forward,
  // Clear Filters) re-sync the mirror during render via a prev-value compare.
  const [statusMirror, setStatusMirror] = useState(selectedStatuses);
  const [prevStatusParam, setPrevStatusParam] = useState(statusParam);
  if (statusParam !== prevStatusParam) {
    setPrevStatusParam(statusParam);
    setStatusMirror(new Set(statusParam.split(",").filter(Boolean)));
  }
  const statusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handleStatusChange = useCallback(
    (next: Set<string>) => {
      setStatusMirror(next);
      clearTimeout(statusTimer.current);
      statusTimer.current = setTimeout(() => {
        const isAll = next.size === 0 || next.size === BATCH_RUN_STATUS_FILTERS.length;
        updateUrl({ status: isAll ? null : Array.from(next).join(","), page: null });
      }, 350);
    },
    [updateUrl],
  );

  const selectedModels = useMemo(() => {
    const raw = searchParams.get("model") ?? "";
    return new Set(raw.split(",").filter(Boolean));
  }, [searchParams]);

  const toggleModel = useCallback(
    (model: string) => {
      const next = new Set(selectedModels);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      updateUrl({ model: Array.from(next).join(",") || null, page: null });
    },
    [selectedModels, updateUrl],
  );
  const clearModels = useCallback(() => {
    updateUrl({ model: null, effort: null, page: null });
  }, [updateUrl]);

  // Serving-host filter (issue #307): the host dimension runs are compared
  // by — "same model, which host was faster/cheaper".
  const selectedHosts = useMemo(() => {
    const raw = searchParams.get("provider") ?? "";
    return new Set(raw.split(",").filter(Boolean));
  }, [searchParams]);
  const toggleHost = useCallback(
    (host: string) => {
      const next = new Set(selectedHosts);
      if (next.has(host)) next.delete(host);
      else next.add(host);
      updateUrl({ provider: Array.from(next).join(",") || null, page: null });
    },
    [selectedHosts, updateUrl],
  );
  const clearHosts = useCallback(() => {
    updateUrl({ provider: null, page: null });
  }, [updateUrl]);

  const modelOptions: ModelOption[] = useMemo(
    () =>
      modelFacets
        .map((f) => ({ model: f.model, count: f.count, archived: f.archived }))
        .sort((a, b) => a.model.localeCompare(b.model)),
    [modelFacets],
  );

  // Archiving retires a model from the dropdowns project-wide. The facets are
  // server-rendered here (a by-product of the runs list), so a refresh is what
  // re-reads them — the Tasks page fetches its palette client-side and splices
  // its own state instead.
  const setModelArchivedState = useCallback(
    async (model: string, archived: boolean) => {
      try {
        await setModelArchived(projectId, model, archived);
        router.refresh();
        toast.success(archived ? "Model archived" : "Model restored");
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : "Failed to update model");
      }
    },
    [projectId, router],
  );

  const selectedEfforts = useMemo(() => {
    const raw = searchParams.get("effort") ?? "";
    return new Set(raw.split(",").filter(Boolean));
  }, [searchParams]);

  // Effort filter — normally shown only when exactly one model is selected and
  // that model has 2+ effort tiers (same pattern as the tasks page). An effort
  // the URL already selects is always listed, whatever the facets hold: a
  // cohort carried in from Tasks, or a shared link, must never leave a filter
  // applied but invisible and unclearable.
  const selectedModelArr = Array.from(selectedModels);
  const effortOptions = useMemo(() => {
    const facet =
      selectedModelArr.length === 1
        ? modelFacets.find((f) => f.model === selectedModelArr[0])
        : undefined;
    const known = facet?.efforts ?? [];
    const missing: { effort: string; count: number }[] = [];
    for (const effort of selectedEfforts) {
      if (!known.some((option) => option.effort === effort)) {
        missing.push({ effort, count: 0 });
      }
    }
    if (selectedEfforts.size === 0 && known.length < 2) return [];
    return [...known, ...missing];
  }, [modelFacets, selectedModelArr, selectedEfforts]);

  // Filters can arrive with the navigation now (a cohort carried over from
  // Tasks), so both the way back to the full list and the empty state have to
  // tell the difference between "no runs" and "none match".
  const hasActiveFilters =
    urlQ !== "" ||
    selectedStatuses.size > 0 ||
    urlSince !== null ||
    selectedModels.size > 0 ||
    selectedEfforts.size > 0 ||
    selectedHosts.size > 0;

  const clearFilters = useCallback(() => {
    // Cancel any in-flight debounced status write so it cannot resurrect a
    // selection the user just cleared.
    clearTimeout(statusTimer.current);
    setStatusMirror(new Set());
    updateUrl({
      q: null,
      status: null,
      model: null,
      effort: null,
      provider: null,
      since: null,
      page: null,
    });
  }, [updateUrl]);

  const handlePageChange = useCallback(
    (newPage: number) => {
      updateUrl({ page: newPage === 0 ? null : String(newPage) });
    },
    [updateUrl],
  );

  // Per-batch count of live task starts, which expanded rows re-fetch on.
  const [taskStartTicks, setTaskStartTicks] = useState<Record<string, number>>({});
  const bumpTaskStartTicks = useCallback((batchRunIds: string[]) => {
    setTaskStartTicks((prev) => {
      const next = { ...prev };
      for (const id of batchRunIds) next[id] = (next[id] ?? 0) + 1;
      return next;
    });
  }, []);

  // Compare selection (max 2 runs, sliding window when a third is picked).
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const compareIdSet = useMemo(() => new Set(compareIds), [compareIds]);
  const toggleCompare = useCallback((id: string) => {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return prev.length >= 2 ? [prev[1], id] : [...prev, id];
    });
  }, []);
  const clearCompare = useCallback(() => setCompareIds([]), []);

  const compareBatches = useMemo(
    () => compareIds.map((id) => batchRuns.find((b) => b.id === id) ?? null),
    [compareIds, batchRuns],
  );
  const overlap = useMemo(
    () =>
      compareBatches.length === 2 && compareBatches[0] && compareBatches[1]
        ? computeOverlap(compareBatches[0], compareBatches[1])
        : null,
    [compareBatches],
  );

  return (
    <div className="flex h-full w-full flex-col">
      <RunsListAutoRefresh
        project={projectId}
        batchRuns={batchRuns}
        watchForNewRuns={page === 0}
        onTasksStarted={bumpTaskStartTicks}
      />
      <RunsToolbar
        urlQ={urlQ}
        selectedStatuses={statusMirror}
        onStatusChange={handleStatusChange}
        urlSince={urlSince}
        selectedModels={selectedModels}
        selectedEfforts={selectedEfforts}
        modelOptions={modelOptions}
        effortOptions={effortOptions}
        totalCount={totalCount}
        hasActiveFilters={hasActiveFilters}
        updateUrl={updateUrl}
        onClearFilters={clearFilters}
        onSetArchived={setModelArchivedState}
      />

      <div className="flex-1 overflow-auto">
        {sourceUnconfigured ? (
          <div className="px-6 py-10">
            <div className="px-6 py-10 text-center text-sm text-neutral-400">
              Run <code className="text-neutral-200">apo task publish</code> to publish your task catalog.
            </div>
          </div>
        ) : batchRuns.length === 0 ? (
          <div className="m-6 border border-dashed border-border bg-card/40 p-10 text-center text-[13px] text-muted-foreground">
            <History className="mx-auto mb-2 h-5 w-5 text-muted-foreground/50" />
            {hasActiveFilters
              ? <>No runs match these filters. <button type="button" onClick={clearFilters} className="text-primary underline underline-offset-4">Clear Filters</button></>
              : <>No runs yet. <Link href={`/project/${projectId}/tasks`} className="text-primary underline underline-offset-4">Discover and run tasks</Link></>}
          </div>
        ) : (
          <Table density="compact">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow className="border-border hover:bg-transparent">
                <TableHead style={{ width: COL.chevron }} />
                <TableHead>Run</TableHead>
                <TableHead style={{ width: COL.source }} className="hidden xl:table-cell">Source</TableHead>
                <TableHead style={{ width: COL.execution }}>
                  <span className="inline-flex items-center gap-1">
                    Execution
                    <RunsModelFilter
                      options={modelOptions}
                      selected={selectedModels}
                      onToggle={toggleModel}
                      onClear={clearModels}
                      onSetArchived={setModelArchivedState}
                    />
                  </span>
                </TableHead>
                <TableHead style={{ width: COL.hosts }} className="hidden xl:table-cell">
                  <span className="inline-flex items-center gap-1">
                    Hosts
                    <RunsHostFilter
                      options={providerFacets}
                      selected={selectedHosts}
                      onToggle={toggleHost}
                      onClear={clearHosts}
                    />
                  </span>
                </TableHead>
                <TableHead style={{ width: COL.tasks }} className="text-right">Tasks {"\u00b7"} Pass rate</TableHead>
                <TableHead style={{ width: COL.duration }} className="text-right">Duration</TableHead>
                <TableHead style={{ width: COL.created }} className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batchRuns.map((b) => (
                <RunsRow
                  key={b.id}
                  batch={b}
                  clientNow={clientNow}
                  projectId={projectId}
                  compareSelected={compareIdSet.has(b.id)}
                  compareDisabled={compareIds.length >= 2 && !compareIdSet.has(b.id)}
                  onToggleCompare={() => toggleCompare(b.id)}
                  modelFilter={selectedModels}
                  canDelete={canDeleteRuns}
                  taskStartTick={taskStartTicks[b.id] ?? 0}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <ListPagination
        totalCount={totalCount}
        page={page}
        pageSize={pageSize}
        totalPages={totalPages}
        itemName="runs"
        onPageChange={handlePageChange}
      />

      {compareIds.length > 0 && (
        <RunsCompareBar
          compareIds={compareIds}
          compareBatches={compareBatches}
          overlap={overlap}
          projectId={projectId}
          onClearCompare={clearCompare}
        />
      )}
    </div>
  );
}
