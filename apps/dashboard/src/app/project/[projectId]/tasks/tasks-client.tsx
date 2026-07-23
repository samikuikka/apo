"use client";

import { useMemo, useState, useReducer } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ChevronRight,
  Clock,
  DollarSign,
  Folder,
  FolderOpen,
  Play,
  Search,
  BarChart3,
  RefreshCw,
  Pencil,
} from "lucide-react";
import {
  createAgentTaskBatchRun,
  type AgentTaskSummary,
  type AgentTaskRunStats,
} from "@/lib/agent-task-api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCostMicro } from "@/lib/format";
import { toast } from "sonner";

import { useProjectId, useIsDemo } from "@/lib/project-router";
import { taskDetailHref } from "@/lib/task-routes";
import {
  type ProjectTaskSource,
  syncProjectTaskSource,
} from "@/lib/projects-api";
import { ProjectTaskSourceSetupCard } from "@/components/project-task-source";
const TASK_ROOT = process.env.NEXT_PUBLIC_AGENT_TASK_ROOT ?? null;

function relativePath(path: string): string {
  if (!TASK_ROOT) return path;
  return path.startsWith(TASK_ROOT) ? path.slice(TASK_ROOT.length).replace(/^\//, "") : path;
}

type FolderNode = {
  id: string;
  tasks: AgentTaskSummary[];
};

function groupByFolder(tasks: AgentTaskSummary[]): FolderNode[] {
  const groups: Record<string, AgentTaskSummary[]> = {};
  for (const task of tasks) {
    const folder = task.folder_path || "(root)";
    if (!groups[folder]) groups[folder] = [];
    groups[folder].push(task);
  }
  return Object.entries(groups).map(([name, tasks]) => ({ id: name, tasks }));
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "\u2014";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

type TaskStatus = "passed" | "failed" | "running" | "idle";

function getTaskStatus(task: AgentTaskSummary): TaskStatus {
  const stats = task.run_stats;
  if (!stats || !stats.last_run_status) return "idle";
  if (stats.last_run_status === "running") return "running";
  if (stats.last_run_passed === true) return "passed";
  return "failed";
}

const STATUS_CONFIG: Record<Exclude<TaskStatus, "idle">, { label: string; dot: string; text: string }> = {
  passed:  { label: "Passed",  dot: "bg-success",              text: "text-success" },
  failed:  { label: "Failed",  dot: "bg-destructive",          text: "text-destructive" },
  running: { label: "Running", dot: "bg-foreground animate-pulse", text: "text-muted-foreground" },
};

function PassBar({ value, muted }: { value: number; muted?: boolean }) {
  // `muted` means there is genuinely nothing to show (running, no data).
  // `value === 0` is different: it means the task ran and every run failed —
  // a red flag we want to surface as 0%, not hide behind an em-dash. Callers
  // already gate rendering on `total_runs > 0`, so a 0 reaching us always
  // means "ran but all failed", never "never ran".
  if (muted) {
    return <span className="font-mono text-[12px] text-muted-foreground/60">\u2014</span>;
  }
  const pct = Math.round(value * 100);
  const color = pct >= 80 ? "bg-success" : pct < 50 ? "bg-destructive" : "bg-warning";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-12 overflow-hidden rounded-full bg-border">
        <div className={cn("h-full", color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right font-mono text-[12px] tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
      <Icon className="h-3.5 w-3.5 text-muted-foreground/60" />
      <span className="text-muted-foreground/60">{label}</span>
      <span className="font-mono tabular-nums text-foreground/70">{value}</span>
    </div>
  );
}

interface AgentTasksClientProps {
  tasks: AgentTaskSummary[];
  error: string | null;
  taskSource: ProjectTaskSource | null;
  isDemo: boolean;
}

function TaskCard({
  task,
  isSel,
  status,
  stats,
  toggleTask,
}: {
  task: AgentTaskSummary;
  isSel: boolean;
  status: TaskStatus;
  stats: AgentTaskRunStats | null;
  toggleTask: (id: string) => void;
}) {
  const projectId = useProjectId();
  const s = status !== "idle" ? STATUS_CONFIG[status] : null;
  return (
    <Link
      href={taskDetailHref(projectId, task.id)}
      className={cn(
        "group/card relative block rounded-md border px-2 py-3 transition-colors",
        isSel
          ? "border-foreground/30 bg-muted/20"
          : "border-border bg-card/40 hover:border-border hover:bg-card/60",
      )}
    >
      {isSel && (
        <span className="pointer-events-none absolute inset-y-2 left-0 w-[2px] rounded-r bg-foreground/60" aria-hidden />
      )}
      <div className="flex items-start gap-3">
        <div
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          className="mt-1"
        >
          <Checkbox
            checked={isSel}
            onCheckedChange={() => toggleTask(task.id)}
            aria-label={`Select ${task.display_name}`}
          />
        </div>
        <div className="w-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {status !== "idle" ? (
              <>
                <span className={cn("h-2 w-2 rounded-full", s!.dot)} aria-hidden />
                <span className="truncate text-[14px] font-medium">{task.display_name}</span>
                <span className={cn("text-[11px] font-medium uppercase tracking-wide", s!.text)}>
                  {s!.label}
                </span>
              </>
            ) : (
              <span className="truncate text-[14px] font-medium text-muted-foreground">{task.display_name}</span>
            )}
            {task.tags.length > 0 && task.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>
            ))}
          </div>

          {status === "idle" ? (
            <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted-foreground/50">
              <Play className="h-3 w-3" />
              <span>Ready to run</span>
              <span className="ml-auto font-mono text-[11px] text-muted-foreground/40">
                {relativePath(task.task_path)}
              </span>
            </div>
          ) : stats && stats.total_runs > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12px]">
              <Stat icon={BarChart3} label="Runs" value={`${stats.total_runs}`} />
              <Stat icon={Clock} label="Avg time" value={formatDuration(stats.avg_duration_ms)} />
              {stats.avg_cost !== null && stats.avg_cost > 0 && (
                <Stat icon={DollarSign} label="Avg cost" value={formatCostMicro(stats.avg_cost)} />
              )}
              <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
                <span className="text-muted-foreground/60">Last run</span>
                <span className="font-mono tabular-nums text-muted-foreground">{formatRelativeTime(stats.last_run_at)}</span>
              </div>
              <span className="hidden font-mono text-[11px] text-muted-foreground/40 md:inline">
                {relativePath(task.task_path)}
              </span>
            </div>
          ) : null}
        </div>
        <div className="hidden shrink-0 items-center gap-2 text-[12px] text-muted-foreground sm:flex" style={{ width: "160px" }}>
          {stats && stats.total_runs > 0 && status !== "idle" && (
            <>
              <span className="text-muted-foreground/60">Pass</span>
              <div className="w-28">
                <PassBar value={stats.pass_rate} muted={status === "running"} />
              </div>
            </>
          )}
        </div>
      </div>
    </Link>
  );
}

function TasksToolbar({
  taskSource,
  isDemoProject,
  editingSource,
  syncing,
  selectedCount,
  runRunning,
  query,
  onQueryChange,
  onEditSource,
  onSync,
  onRun,
  onClearSelection,
  onToggleExpandAll,
  allExpanded,
}: {
  taskSource: ProjectTaskSource | null;
  isDemoProject: boolean;
  editingSource: boolean;
  syncing: boolean;
  selectedCount: number;
  runRunning: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  onEditSource: () => void;
  onSync: () => void;
  onRun: () => void;
  onClearSelection: () => void;
  onToggleExpandAll: () => void;
  allExpanded: boolean;
}) {
  return (
    <div className="border-b border-border">
      <div className="flex flex-col gap-3 px-6 py-5 lg:flex-row lg:items-center lg:justify-end">
        <div className="flex items-center gap-2">
          {taskSource && !isDemoProject && (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onEditSource}
                disabled={editingSource}
                className="h-8 gap-1.5 text-[13px] font-normal"
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit source
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onSync}
                disabled={syncing}
                className="h-8 gap-1.5 text-[13px] font-normal"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
                {syncing ? "Syncing…" : "Resync"}
              </Button>
            </>
          )}
          <Button type="button"
            size="sm"
            disabled={selectedCount === 0 || runRunning || isDemoProject}
            onClick={onRun}
            title={isDemoProject ? "Demo workspace is read-only" : undefined}
            className="h-8 gap-1.5 text-[13px] font-medium disabled:opacity-40"
          >
            <Play className="h-3.5 w-3.5 fill-current" />
            {runRunning ? "Starting..." : selectedCount > 0 ? `Run ${selectedCount} task${selectedCount > 1 ? "s" : ""}` : "Run selected"}
          </Button>
        </div>
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-6 py-2.5">
        <div className="relative min-w-[240px] flex-1 max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Filter tasks..."
            className="h-8 border-border bg-card pl-8 text-[13px] placeholder:text-muted-foreground/50 focus-visible:border-border"
          />
        </div>
        <div className="ml-auto flex items-center gap-3 text-[12px] text-muted-foreground">
          {selectedCount > 0 && (
            <>
              <span>
                <span className="font-medium text-foreground/70">{selectedCount}</span> selected
              </span>
              <button type="button"
                onClick={onClearSelection}
                className="underline-offset-2 hover:text-foreground/70 hover:underline"
              >
                Clear
              </button>
              <div className="h-4 w-px bg-border" />
            </>
          )}
          <button type="button"
            onClick={onToggleExpandAll}
            className="hover:text-foreground/70"
          >
            {allExpanded ? "Collapse all" : "Expand all"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FolderRow({
  folder,
  state,
  isOpen,
  selected,
  toggleFolder,
  toggleTask,
  toggleExpand,
}: {
  folder: FolderNode;
  state: "none" | "some" | "all";
  isOpen: boolean;
  selected: Set<string>;
  toggleFolder: (folder: FolderNode) => void;
  toggleTask: (id: string) => void;
  toggleExpand: (id: string) => void;
}) {
  const selectedCount = folder.tasks.filter((t) => selected.has(t.id)).length;
  const runnableTasks = folder.tasks.filter((t) => t.run_stats && (t.run_stats.pass_rate > 0 || t.run_stats.last_run_status));
  const folderPass = runnableTasks.length > 0
    ? Math.round(runnableTasks.reduce((s, t) => s + (t.run_stats?.pass_rate ?? 0), 0) / runnableTasks.length * 100)
    : 0;

  return (
    <div key={folder.id} className="border-b border-border last:border-b-0 py-2">
      {/* Folder row */}
      <div
        className={cn(
          "group flex items-center gap-3 rounded-md px-2 py-2 transition-colors",
          state !== "none" ? "bg-card/40" : "hover:bg-muted/10",
        )}
      >
        <Checkbox
          checked={state === "all" ? true : state === "some" ? "indeterminate" : false}
          onCheckedChange={() => toggleFolder(folder)}
          aria-label={`Select all in ${folder.id}`}
        />
        <button type="button"
          onClick={() => toggleExpand(folder.id)}
          className="grid h-5 w-5 place-items-center rounded text-muted-foreground/60 hover:bg-border hover:text-foreground/70"
          aria-label={isOpen ? "Collapse" : "Expand"}
        >
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-90")} />
        </button>
        <button type="button"
          onClick={() => toggleExpand(folder.id)}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          {isOpen ? (
            <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-mono text-[14px] font-medium">{folder.id}</span>
          <span className="rounded bg-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {folder.tasks.length} tasks
          </span>
          {selectedCount > 0 && (
            <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] font-medium text-black">
              {selectedCount} selected
            </span>
          )}
        </button>
        <div className="hidden shrink-0 items-center gap-2 text-[12px] text-muted-foreground sm:flex" style={{ width: "160px" }}>
          {runnableTasks.length > 0 && (
            <>
              <span className="text-muted-foreground/60">Pass</span>
              <div className="w-28"><PassBar value={folderPass / 100} /></div>
            </>
          )}
        </div>
      </div>

      {/* Task cards */}
      {isOpen && (
        <div className="mt-1 space-y-1">
          {folder.tasks.map((task) => {
            const isSel = selected.has(task.id);
            const status = getTaskStatus(task);
            return (
              <TaskCard
                key={task.id}
                task={task}
                isSel={isSel}
                status={status}
                stats={task.run_stats}
                toggleTask={toggleTask}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function SelectionActionBar({
  selectedCount,
  runRunning,
  isDemoProject,
  onClear,
  onRun,
}: {
  selectedCount: number;
  runRunning: boolean;
  isDemoProject: boolean;
  onClear: () => void;
  onRun: () => void;
}) {
  return (
    <div className="sticky bottom-4 z-20 mx-auto mb-4 w-fit">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 shadow-2xl shadow-black/60">
        <div className="flex items-center gap-2 text-[12px]">
          <span className="grid h-5 min-w-5 place-items-center rounded bg-white px-1 font-mono text-[11px] font-semibold text-black">
            {selectedCount}
          </span>
          <span className="text-muted-foreground">
            task{selectedCount > 1 ? "s" : ""} selected
          </span>
        </div>
        <div className="h-5 w-px bg-border" />
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[12px] font-normal text-muted-foreground hover:text-foreground/70" onClick={onClear}>
          Clear
        </Button>
        <Button type="button" size="sm" className="h-7 gap-1.5 px-3 text-[12px] font-medium" onClick={onRun} disabled={runRunning || isDemoProject} title={isDemoProject ? "Demo workspace is read-only" : undefined}>
          <Play className="h-3 w-3 fill-current" />
          {runRunning ? "Starting..." : "Run selection"}
        </Button>
      </div>
    </div>
  );
}

export function AgentTasksClient({
  tasks,
  error,
  taskSource,
  isDemo,
}: AgentTasksClientProps) {
  const projectId = useProjectId();
  const router = useRouter();
  // Prefer the prop (canonical, server-fetched) and fall back to the
  // client hook for any sub-render that might lack it.
  const clientIsDemo = useIsDemo();
  const isDemoProject = isDemo || clientIsDemo;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [editingSource, setEditingSource] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const folders = groupByFolder(tasks);
    return new Set(folders.map((f) => f.id));
  });
  const [query, setQuery] = useState("");
  const [runState, dispatchRun] = useReducer(
    (s: { running: boolean; error: string | null }, a:
      | { type: "START" }
      | { type: "SUCCESS" }
      | { type: "ERROR"; error: string }
    ) => {
      switch (a.type) {
        case "START": return { running: true, error: null };
        case "SUCCESS": return { running: false, error: null };
        case "ERROR": return { running: false, error: a.error };
      }
    },
    { running: false, error: null },
  );

  const folders = useMemo(() => groupByFolder(tasks), [tasks]);

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

  const toggleTask = (taskId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });

  const toggleFolder = (folder: FolderNode) => {
    const ids = folder.tasks.map((t) => t.id);
    const allSelected = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  };

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const folderState = (folder: FolderNode) => {
    const ids = folder.tasks.map((t) => t.id);
    const count = ids.filter((id) => selected.has(id)).length;
    if (count === 0) return "none" as const;
    if (count === ids.length) return "all" as const;
    return "some" as const;
  };

  const handleSync = async () => {
    if (syncing || isDemoProject || !taskSource) return;
    setSyncing(true);
    try {
      await syncProjectTaskSource(projectId);
      toast.success("Task source synced");
      router.refresh();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const handleRun = async () => {
    if (selected.size === 0 || isDemoProject) return;
    dispatchRun({ type: "START" });
    try {
      const selectedTasks = tasks.filter((t) => selected.has(t.id));
      const selectedPaths = selectedTasks.map((t) => t.task_path);
      const result = await createAgentTaskBatchRun({
        project: projectId,
        selection_type: selectedPaths.length === 1 ? "task" : "tasks",
        task_paths: selectedPaths,
        task_root: TASK_ROOT,
        run_metadata: {
          trigger: {
            source: "dashboard",
            user_agent: typeof navigator === "undefined" ? null : navigator.userAgent,
            entrypoint: "/tasks",
            initiated_at: new Date().toISOString(),
          },
        },
      });
      window.location.href = `/project/${projectId}/runs/${result.id}`;
    } catch (e: unknown) {
      dispatchRun({ type: "ERROR", error: e instanceof Error ? e.message : "Failed to start batch run" });
    }
  };

  const allFolderIds = folders.map((f) => f.id);
  const allExpanded = allFolderIds.length > 0 && allFolderIds.every((id) => expanded.has(id));

  // Non-demo projects only replace the task list with setup UI when
  // there is no configured source or the persisted inventory belongs
  // to an older source root/ref/subpath. Other source states keep the
  // task list visible so routine resyncs do not hide valid tasks.
  const sourceNeedsAttention =
    taskSource?.inventory_stale === true;
  const showSetupCard =
    !isDemoProject &&
    !error &&
    (taskSource === null || sourceNeedsAttention);

  return (
    <div className="flex flex-col">
      {editingSource && taskSource && !isDemoProject ? (
        <div className="border-b border-border px-6 py-10">
          <ProjectTaskSourceSetupCard
            projectId={projectId}
            taskSource={taskSource}
            isDemo={isDemoProject}
            startInEdit
            onSynced={() => setEditingSource(false)}
          />
          <div className="mx-auto mt-4 flex w-full max-w-2xl justify-end">
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
      ) : showSetupCard ? (
        <div className="px-6 py-10">
          <ProjectTaskSourceSetupCard
            projectId={projectId}
            taskSource={taskSource}
            isDemo={isDemoProject}
          />
        </div>
      ) : (
        <>
      <TasksToolbar
        taskSource={taskSource}
        isDemoProject={isDemoProject}
        editingSource={editingSource}
        syncing={syncing}
        selectedCount={selected.size}
        runRunning={runState.running}
        query={query}
        onQueryChange={setQuery}
        onEditSource={() => setEditingSource(true)}
        onSync={handleSync}
        onRun={handleRun}
        onClearSelection={() => setSelected(new Set())}
        onToggleExpandAll={() => setExpanded(allExpanded ? new Set() : new Set(allFolderIds))}
        allExpanded={allExpanded}
      />

      {/* Error alerts */}
      {(error || runState.error) && (
        <div className="mx-6 mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
          {error || runState.error}
        </div>
      )}

      {/* Empty state */}
      {!error && tasks.length === 0 && (
        <div className="m-6 rounded-md border border-dashed border-border bg-muted/10 p-10 text-center text-[13px] text-muted-foreground">
          No agent tasks discovered. Ensure the task root directory is configured.
        </div>
      )}

      {/* Folder list */}
      <div className="px-6 py-1">
        {filtered.map((folder) => (
          <FolderRow
            key={folder.id}
            folder={folder}
            state={folderState(folder)}
            isOpen={expanded.has(folder.id) || !!query}
            selected={selected}
            toggleFolder={toggleFolder}
            toggleTask={toggleTask}
            toggleExpand={toggleExpand}
          />
        ))}

        {filtered.length === 0 && query && (
          <div className="m-6 rounded-md border border-dashed border-border bg-muted/10 p-10 text-center text-[13px] text-muted-foreground">
            No tasks match <span className="font-mono text-foreground/70">&quot;{query}&quot;</span>
          </div>
        )}
      </div>

      {/* Sticky bottom action bar */}
      {selected.size > 0 && (
        <SelectionActionBar
          selectedCount={selected.size}
          runRunning={runState.running}
          isDemoProject={isDemoProject}
          onClear={() => setSelected(new Set())}
          onRun={handleRun}
        />
      )}
        </>
      )}
    </div>
  );
}
