"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { type AgentTaskSummary } from "@/lib/agent-task-api";
import { Button } from "@/components/ui/button";

import { useProjectId, useIsDemo } from "@/lib/project-router";
import { usePublishRunCohort } from "@/lib/run-cohort-context";
import { setSearchParamShallow } from "@/lib/shallow-search-params";
import type { ProjectTaskSource } from "@/lib/projects-api";
import type { ProjectFirstRunSetup } from "@/lib/first-run";

import { EvidenceViewsBar } from "./components/EvidenceViewsBar";
import { FolderList } from "./components/FolderList";
import { ProjectFirstRun } from "./components/ProjectFirstRun";
import { SelectionActionBar } from "./components/SelectionActionBar";
import { TasksToolbar } from "./components/TasksToolbar";
import { useEvidenceViews } from "./components/use-evidence-views";
import { fetchTaskHostFacets } from "@/lib/agent-task-view-api";
import { useTaskSelection } from "./components/use-task-selection";
import { useTaskRunActions } from "./components/use-task-run-actions";
import {
  groupByFolder,
  MAIN_VIEW_ID,
  STATUS_FILTER_KEYS,
  taskFilterStatus,
} from "./components/task-list-shared";

interface AgentTasksClientProps {
  tasks: AgentTaskSummary[];
  error: string | null;
  taskSource: ProjectTaskSource | null;
  isDemo: boolean;
  /** Write affordances render only when the permission summary allows. */
  canRunTasks?: boolean;
  firstRunSetup?: ProjectFirstRunSetup | null;
  /** `?view=` from the URL: re-select that saved tab on arrival. */
  initialViewId?: string | null;
}

export function AgentTasksClient({
  tasks,
  error,
  taskSource,
  isDemo,
  canRunTasks = true,
  firstRunSetup = null,
  initialViewId = null,
}: AgentTasksClientProps) {
  const projectId = useProjectId();
  const clientIsDemo = useIsDemo();
  const isDemoProject = isDemo || clientIsDemo;
  const searchParams = useSearchParams();
  const [editingSource, setEditingSource] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const folders = groupByFolder(tasks);
    return new Set(folders.map((f) => f.id));
  });
  // Search and status persist in the URL (shallow — no server refetch) so a
  // filtered view is shareable and survives reload, like Runs/Task-detail.
  // The local mirror drives re-renders; the shallow write keeps the address
  // bar in sync without depending on Next's history integration.
  const [query, setQueryState] = useState(() => searchParams.get("q") ?? "");
  const [statusParam, setStatusParamState] = useState(
    () => searchParams.get("status") ?? "",
  );
  const setQuery = useCallback((value: string) => {
    setQueryState(value);
    setSearchParamShallow("q", value || null);
  }, []);
  const statusFilter = useMemo(
    () => new Set(statusParam.split(",").filter(Boolean)),
    [statusParam],
  );
  // Empty or all-selected means "no status filter": drop the param entirely
  // so the URL stays clean and reloads show everything.
  const handleStatusChange = useCallback(
    (next: Set<string>) => {
      const isAll = next.size === 0 || next.size === STATUS_FILTER_KEYS.length;
      const joined = isAll ? "" : Array.from(next).join(",");
      setStatusParamState(joined);
      setSearchParamShallow("status", joined || null);
    },
    [],
  );

  const {
    views,
    activeView,
    activeViewId,
    setActiveViewId,
    facets,
    addingTab,
    viewStatsLoading,
    effectiveTasks,
    updateActiveView,
    duplicateActive,
    closeView,
    setModelArchivedState,
  } = useEvidenceViews({ projectId, isDemoProject, tasks, initialViewId });

  // Keep the active tab in the URL (?view=<id>) so a reload — or arriving
  // back from a task's detail page — re-opens the same view. Main is the
  // default, so it drops the param instead of writing view=main, mirroring
  // how an "all" status filter stays out of the URL. Covers every path that
  // moves the tab: select, duplicate, close-active, and the fallback when a
  // bookmarked ?view= no longer exists.
  useEffect(() => {
    setSearchParamShallow(
      "view",
      activeViewId === MAIN_VIEW_ID ? null : activeViewId,
    );
  }, [activeViewId]);

  // The active tab is a model/effort/date cohort. Publish it so the Runs nav
  // link opens the same cohort instead of the unfiltered run list; Main
  // publishes an empty cohort, which leaves the link plain. The saved-view
  // identity rides along so task cards can carry ?view= into the detail page.
  usePublishRunCohort(
    {
      model: activeView.model,
      effort: activeView.effort,
      since: activeView.since,
      provider: activeView.provider,
    },
    activeViewId !== MAIN_VIEW_ID ? activeViewId : null,
  );

  // Serving-host palette for the Tasks page's Hosts view filter (issue #307).
  // The host is a refinement of the model ("same model, which host"), so —
  // like the effort tiers — the palette loads for the selected model's runs
  // and the control appears only once a model is pinned.
  const [hostFacets, setHostFacets] = useState<{ label: string; count: number }[]>([]);
  useEffect(() => {
    if (isDemoProject || !activeView.model) {
      setHostFacets([]);
      return;
    }
    const controller = new AbortController();
    fetchTaskHostFacets(projectId, controller.signal, activeView.model)
      .then((f) => setHostFacets(f))
      .catch(() => {});
    return () => controller.abort();
  }, [projectId, isDemoProject, activeView.model]);

  const statusFilteredTasks = useMemo<AgentTaskSummary[]>(() => {
    // No param = all statuses; an explicitly-complete selection is also "all"
    // (and covers taskFilterStatus's transient "running", which is not a
    // filterable vocabulary value).
    if (statusFilter.size === 0 || statusFilter.size === STATUS_FILTER_KEYS.length) {
      return effectiveTasks;
    }
    return effectiveTasks.filter((t) => statusFilter.has(taskFilterStatus(t)));
  }, [effectiveTasks, statusFilter]);

  // Per-status counts for the status menu rows.
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const task of effectiveTasks) {
      const key = taskFilterStatus(task);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [effectiveTasks]);

  const folders = useMemo(() => groupByFolder(statusFilteredTasks), [statusFilteredTasks]);

  const filtered = useMemo(() => {
    if (!query) return folders;
    const q = query.toLowerCase();
    return folders.reduce<typeof folders>((acc, f) => {
      const fm = f.id.toLowerCase().includes(q);
      const fTasks = fm ? f.tasks : f.tasks.filter((t) => t.display_name.toLowerCase().includes(q) || t.task_path.toLowerCase().includes(q));
      if (fTasks.length > 0) acc.push({ ...f, tasks: fTasks });
      return acc;
    }, []);
  }, [query, folders]);

  const {
    selected,
    setSelected,
    toggleTask,
    toggleFolder,
    toggleSelectAll,
    selectAllState,
    visibleTaskIds,
  } = useTaskSelection({ folders: filtered });

  const {
    syncing,
    handleSync,
    runState,
    handleRun,
    comparing,
    handleCompare,
  } = useTaskRunActions({
    projectId,
    isDemoProject,
    taskSource,
    tasks,
    selected,
    activeView,
  });

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allFolderIds = folders.map((f) => f.id);
  const allExpanded = allFolderIds.length > 0 && allFolderIds.every((id) => expanded.has(id));

  // Non-demo projects only replace the task list with setup UI when
  // there is no configured source or the persisted inventory belongs
  // to an older source root/ref/subpath. Other source states keep the
  // task list visible so routine resyncs do not hide valid tasks.
  const sourceNeedsAttention =
    taskSource?.inventory_stale === true;
  // A virgin Project gets the full first-run journey instead
  // of the one-line publish hint; it disappears on durable progress.
  const showFirstRun = firstRunSetup !== null;
  const showSetupCard =
    !isDemoProject &&
    !error &&
    !showFirstRun &&
    (taskSource === null || sourceNeedsAttention);

  return (
    <div className="flex flex-col">
      {editingSource && taskSource && !isDemoProject ? (
        <div className="border-b border-border px-6 py-10">
          <div className="mx-auto max-w-2xl">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setEditingSource(false)}
            >
              Done
            </Button>
          </div>
        </div>
      ) : showFirstRun ? (
        <ProjectFirstRun setup={firstRunSetup} />
      ) : showSetupCard ? (
        <div className="px-6 py-10">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6 text-center">
            <p className="text-sm text-neutral-400">
              Run <code className="text-neutral-200">apo task publish</code> to publish your task catalog.
            </p>
          </div>
        </div>
      ) : (
        <>
          <TasksToolbar
            taskSource={taskSource}
            isDemoProject={isDemoProject}
            canRunTasks={canRunTasks}
            editingSource={editingSource}
            syncing={syncing}
            selectedCount={selected.size}
            runRunning={runState.running}
            onEditSource={() => setEditingSource(true)}
            onSync={handleSync}
            onRun={handleRun}
          />
          {tasks.length > 0 && (
            <EvidenceViewsBar
              hostFacets={hostFacets}
              views={views}
              activeViewId={activeViewId}
              facets={facets}
              loading={viewStatsLoading}
              isDerived={
                activeView.model !== null ||
                activeView.effort !== null ||
                activeView.provider !== null
              }
              viewsActive={!isDemoProject}
              addingTab={addingTab}
              statusCounts={statusCounts}
              query={query}
              onQueryChange={setQuery}
              selectedCount={selected.size}
              onClearSelection={() => setSelected(new Set())}
              onToggleExpandAll={() => setExpanded(allExpanded ? new Set() : new Set(allFolderIds))}
              allExpanded={allExpanded}
              status={statusFilter}
              onStatusChange={handleStatusChange}
              onSelect={setActiveViewId}
              onChange={updateActiveView}
              onSetArchived={setModelArchivedState}
              onDuplicate={duplicateActive}
              onClose={closeView}
            />
          )}

      {/* Error alerts */}
      {(error || runState.error) && (
        <div className="mx-6 mt-4 border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
          {error || runState.error}
        </div>
      )}

      {/* Empty state */}
      {!error && tasks.length === 0 && (
        <div className="m-6 border border-dashed border-border bg-muted/10 p-10 text-center text-[13px] text-muted-foreground">
          No agent tasks discovered. Configure the task source above, or run{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">
            apo task list
          </code>{" "}
          in the project to verify discovery.
        </div>
      )}

      {/* Folder list */}
      <FolderList
        folders={filtered}
        expanded={expanded}
        selected={selected}
        query={query}
        selectAllState={selectAllState}
        visibleTaskCount={visibleTaskIds.length}
        onToggleSelectAll={toggleSelectAll}
        onToggleFolder={toggleFolder}
        onToggleTask={toggleTask}
        onToggleExpand={toggleExpand}
      />

      {/* Sticky bottom action bar */}
      {selected.size > 0 && (
        <SelectionActionBar
          selectedCount={selected.size}
          runRunning={runState.running}
          comparing={comparing}
          isDemoProject={isDemoProject}
          canRunTasks={canRunTasks}
          compareOptions={[
            ...facets.flatMap((f) =>
              f.model !== activeView.model ? [{ model: f.model, label: f.model }] : [],
            ),
            ...(activeView.model !== null ? [{ model: null as string | null, label: "All models" }] : []),
          ]}
          onClear={() => setSelected(new Set())}
          onRun={handleRun}
          onCompare={handleCompare}
        />
      )}
        </>
      )}
    </div>
  );
}
