"use client";

import { useEffect, useMemo, useRef, useState, useReducer } from "react";
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
  Plus,
  X,
  GitCompare,
} from "lucide-react";
import {
  createAgentTaskBatchRun,
  type AgentTaskSummary,
  type AgentTaskRunStats,
} from "@/lib/agent-task-api";
import {
  createTaskViewComparison,
  fetchTaskViewConfigFacets,
  fetchTaskViewStats,
  type RunConfigModelFacet,
  type TaskViewConfig,
} from "@/lib/agent-task-view-api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatCostMicro } from "@/lib/format";
import { toast } from "sonner";

import { useProjectId, useIsDemo } from "@/lib/project-router";
import { taskDetailHref } from "@/lib/task-routes";
import {
  type ProjectTaskSource,
  syncProjectTaskSource,
} from "@/lib/projects-api";

const TASK_ROOT = process.env.NEXT_PUBLIC_AGENT_TASK_ROOT ?? null;

function relativePath(path: string): string {
  if (!TASK_ROOT) return path;
  return path.startsWith(TASK_ROOT) ? path.slice(TASK_ROOT.length).replace(/^\//, "") : path;
}

type FolderNode = {
  id: string;
  tasks: AgentTaskSummary[];
};

// SPEC-174 evidence views: a tab is a model/effort filter. The Main tab
// (model=null) is permanent and shows all-history; every other tab is a
// closable copy narrowed by model (+ model-aware effort).
const MAIN_VIEW_ID = "main";

interface ViewTab {
  id: string;
  label: string;
  model: string | null;  // null = All models (Main)
  effort: string | null; // null = any effort
}

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
        "group/card relative block border px-2 py-3 transition-colors",
        isSel
          ? "border-foreground/30 bg-muted/20"
          : "border-border bg-card/40 hover:border-border hover:bg-card/60",
      )}
    >
      {isSel && (
        <span className="pointer-events-none absolute inset-y-2 left-0 w-[2px] bg-foreground/60" aria-hidden />
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

const ALL_MODELS_VALUE = "__all__";
const ANY_EFFORT_VALUE = "__any__";

/** A short, human-readable config line for a tab chip (e.g. "Opus · high"). */
function viewConfigLabel(view: ViewTab): string {
  if (view.model === null && view.effort === null) return "everything";
  const parts: string[] = [view.model ?? "all models"];
  if (view.effort) parts.push(view.effort);
  return parts.join(" · ");
}

function EvidenceViewsBar({
  views,
  activeViewId,
  facets,
  loading,
  isDerived,
  onSelect,
  onChange,
  onDuplicate,
  onClose,
}: {
  views: ViewTab[];
  activeViewId: string;
  facets: RunConfigModelFacet[];
  loading: boolean;
  isDerived: boolean;
  onSelect: (id: string) => void;
  onChange: (patch: Partial<Pick<ViewTab, "model" | "effort" | "label">>) => void;
  onDuplicate: () => void;
  onClose: (id: string) => void;
}) {
  const active = views.find((v) => v.id === activeViewId) ?? views[0]!;
  const activeModelFacet = facets.find((f) => f.model === active.model);
  // Effort is model-aware: only reveal the control for a specific model that
  // has 2+ distinct effort tiers in the data (SPEC-174 / option B).
  const effortOptions =
    active.model !== null && activeModelFacet && activeModelFacet.efforts.length > 1
      ? activeModelFacet.efforts
      : [];

  function changeModel(value: string) {
    const model = value === ALL_MODELS_VALUE ? null : value;
    // Clear effort if the new model no longer has it, so the view never
    // carries a filter the UI cannot show.
    const facet = facets.find((f) => f.model === model);
    const keepsEffort = facet ? facet.efforts.some((e) => e.effort === active.effort) : false;
    onChange({ model, effort: keepsEffort ? active.effort : null });
  }

  return (
    <div className="border-b border-border">
      {/* Tabs: Main is permanent; every other tab is a closable derived copy. */}
      <div className="flex flex-wrap items-stretch gap-px px-6 py-2">
        {views.map((v) => {
          const isActive = v.id === activeViewId;
          const isMain = v.id === MAIN_VIEW_ID;
          return (
            <div key={v.id} className="flex items-stretch">
              <button
                type="button"
                onClick={() => onSelect(v.id)}
                className={cn(
                  "flex flex-col items-start gap-0.5 border px-2.5 py-1.5 text-left transition-colors",
                  isActive ? "border-input bg-input/30" : "border-border hover:bg-muted/10",
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span className={cn("text-[12px] font-medium", isActive ? "text-foreground" : "text-muted-foreground")}>
                    {v.label}
                  </span>
                  {isMain && (
                    <span className="border border-border px-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground/60">
                      main
                    </span>
                  )}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground/60">{viewConfigLabel(v)}</span>
              </button>
              {!isMain && (
                <button
                  type="button"
                  aria-label={`Close ${v.label} tab`}
                  onClick={() => onClose(v.id)}
                  className="grid place-items-center px-1 text-muted-foreground/30 hover:text-destructive"
                  title="Close tab"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={onDuplicate}
          className="ml-1 flex items-center gap-1 px-2 py-1.5 text-[12px] text-muted-foreground/60 hover:text-foreground/70"
          title="Duplicate the active tab, then edit its filters"
        >
          <Plus className="h-3 w-3" />
          Duplicate
        </button>
      </div>

      {/* Active tab's filter: Model + model-aware Effort. */}
      <div className="flex flex-wrap items-center gap-2 px-6 py-1.5">
        <FilterPicker
          label="Model"
          value={active.model ?? ALL_MODELS_VALUE}
          options={[
            { value: ALL_MODELS_VALUE, label: "All models" },
            ...facets.map((f) => ({ value: f.model, label: f.model })),
          ]}
          onChange={changeModel}
        />
        {effortOptions.length > 0 && (
          <FilterPicker
            label="Effort"
            value={active.effort ?? ANY_EFFORT_VALUE}
            options={[
              { value: ANY_EFFORT_VALUE, label: "Any effort" },
              ...effortOptions.map((e) => ({ value: e.effort, label: e.effort })),
            ]}
            onChange={(value) => onChange({ effort: value === ANY_EFFORT_VALUE ? null : value })}
          />
        )}
        {isDerived && (
          <span className="font-mono text-[10px] text-muted-foreground/50">
            {loading ? "loading scoped stats…" : "scoped to this view"}
          </span>
        )}
      </div>
    </div>
  );
}

function FilterPicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex shrink-0 items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground/60">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger size="sm" className="h-7 text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value} className="text-[12px]">
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
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
          "group flex items-center gap-3 px-2 py-2 transition-colors",
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
          className="grid h-5 w-5 place-items-center text-muted-foreground/60 hover:bg-border hover:text-foreground/70"
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
          <span className="bg-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {folder.tasks.length} tasks
          </span>
          {selectedCount > 0 && (
            <span className="bg-white px-1.5 py-0.5 font-mono text-[11px] font-medium text-black">
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
  comparing,
  isDemoProject,
  onClear,
  onRun,
  onCompare,
}: {
  selectedCount: number;
  runRunning: boolean;
  comparing: boolean;
  isDemoProject: boolean;
  onClear: () => void;
  onRun: () => void;
  onCompare: () => void;
}) {
  return (
    <div className="sticky bottom-4 z-20 mx-auto mb-4 w-fit">
      <div className="flex items-center gap-3 border border-border bg-card px-3 py-2 shadow-2xl shadow-black/60">
        <div className="flex items-center gap-2 text-[12px]">
          <span className="grid h-5 min-w-5 place-items-center bg-white px-1 font-mono text-[11px] font-semibold text-black">
            {selectedCount}
          </span>
          <span className="text-muted-foreground">
            task{selectedCount > 1 ? "s" : ""} selected
          </span>
        </div>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[12px] font-normal text-muted-foreground hover:text-foreground/70" onClick={onClear}>
          Clear
        </Button>
        <Button type="button" size="sm" className="h-7 gap-1.5 px-3 text-[12px] font-medium" onClick={onRun} disabled={runRunning || isDemoProject} title={isDemoProject ? "Demo workspace is read-only" : undefined}>
          <Play className="h-3 w-3 fill-current" />
          {runRunning ? "Starting..." : "Run selection"}
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-7 gap-1.5 px-3 text-[12px] font-medium"
          onClick={onCompare}
          disabled={comparing || isDemoProject}
          title={isDemoProject ? "Demo workspace is read-only" : "Compare the selection under two views (latest run per task)"}
        >
          <GitCompare className="h-3 w-3" />
          {comparing ? "Building…" : "Compare"}
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

  // ---- Evidence views (SPEC-174): a permanent "Main" tab (all-history) plus
  // closable derived tabs narrowed by model (+ model-aware effort). The stats
  // shown in the task table are scoped to the active tab's cohort.
  const [views, setViews] = useState<ViewTab[]>([{ id: MAIN_VIEW_ID, label: "Main", model: null, effort: null }]);
  const [activeViewId, setActiveViewId] = useState<string>(MAIN_VIEW_ID);
  const [facets, setFacets] = useState<RunConfigModelFacet[]>([]);
  // Per-task stats overlay for the active derived view. null = Main (use the
  // all-history run_stats already attached to each task by the server).
  const [viewStats, setViewStats] = useState<Record<string, AgentTaskRunStats> | null>(null);
  const [viewStatsLoading, setViewStatsLoading] = useState(false);
  const activeView = views.find((v) => v.id === activeViewId) ?? views[0]!;
  const viewSeq = useRef(0);

  // Load the model/effort palette once for the project's runs.
  useEffect(() => {
    if (isDemoProject) return;
    let cancelled = false;
    fetchTaskViewConfigFacets(projectId)
      .then((f) => { if (!cancelled) setFacets(f); })
      .catch(() => { /* palette is best-effort; filters just stay empty */ });
    return () => { cancelled = true; };
  }, [projectId, isDemoProject]);

  // When the active tab is a derived view, fetch its scoped stats and overlay
  // them. Main reuses the server-provided all-history stats (viewStats = null).
  useEffect(() => {
    if (isDemoProject || (activeView.model === null && activeView.effort === null)) {
      setViewStats(null);
      return;
    }
    const controller = new AbortController();
    setViewStatsLoading(true);
    fetchTaskViewStats(projectId, activeView.model, activeView.effort, controller.signal)
      .then((stats) => { setViewStats(stats); })
      .catch(() => { /* keep previous overlay on transient failure */ })
      .finally(() => { if (!controller.signal.aborted) setViewStatsLoading(false); });
    return () => controller.abort();
  }, [projectId, activeView.model, activeView.effort, isDemoProject]);

  // The task table renders against this: original tasks for Main, or the same
  // tasks with view-scoped stats overlaid for a derived tab (tasks with no run
  // under the view get null stats → render as "Ready to run").
  const effectiveTasks = useMemo<AgentTaskSummary[]>(() => {
    if (!viewStats) return tasks;
    return tasks.map((t) => ({ ...t, run_stats: viewStats[t.id] ?? null }));
  }, [tasks, viewStats]);

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

  const folders = useMemo(() => groupByFolder(effectiveTasks), [effectiveTasks]);

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

  // ---- Evidence view tab operations ----
  const updateActiveView = (patch: Partial<Pick<ViewTab, "model" | "effort" | "label">>) => {
    setViews((prev) => prev.map((v) => (v.id === activeViewId ? { ...v, ...patch } : v)));
  };
  const duplicateActive = () => {
    viewSeq.current += 1;
    const id = `view-${viewSeq.current}`;
    setViews((prev) => [...prev, { ...activeView, id, label: `View ${viewSeq.current}` }]);
    setActiveViewId(id);
  };
  const closeView = (id: string) => {
    if (id === MAIN_VIEW_ID) return;
    setViews((prev) => prev.filter((v) => v.id !== id));
    if (activeViewId === id) setActiveViewId(MAIN_VIEW_ID);
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
      const taskIds = selectedTasks.map((t) => t.id);
      const result = await createAgentTaskBatchRun({
        project: projectId,
        task_ids: taskIds,
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

  // SPEC-174 Phase 2: build an immutable snapshot of the selection under two
  // views and navigate to the comparison page. Side A = the active tab's view;
  // side B defaults to a contrasting model (the first one that differs), or to
  // Main if the active tab is already a model view with no alternative.
  const [comparing, setComparing] = useState(false);
  const handleCompare = async () => {
    if (selected.size === 0 || isDemoProject) return;
    setComparing(true);
    try {
      const viewA: TaskViewConfig = { model: activeView.model, effort: activeView.effort };
      const altModel = facets.find((f) => f.model !== activeView.model)?.model ?? null;
      const viewB: TaskViewConfig = { model: altModel, effort: null };
      const snapshot = await createTaskViewComparison(projectId, {
        task_ids: [...selected],
        view_a: viewA,
        view_b: viewB,
      });
      router.push(`/project/${projectId}/compare-views/${snapshot.id}`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to build comparison");
    } finally {
      setComparing(false);
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
          {!isDemoProject && tasks.length > 0 && (
            <EvidenceViewsBar
              views={views}
              activeViewId={activeViewId}
              facets={facets}
              loading={viewStatsLoading}
              isDerived={activeView.model !== null || activeView.effort !== null}
              onSelect={setActiveViewId}
              onChange={updateActiveView}
              onDuplicate={duplicateActive}
              onClose={closeView}
            />
          )}
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
        <div className="mx-6 mt-4 border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
          {error || runState.error}
        </div>
      )}

      {/* Empty state */}
      {!error && tasks.length === 0 && (
        <div className="m-6 border border-dashed border-border bg-muted/10 p-10 text-center text-[13px] text-muted-foreground">
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
          <div className="m-6 border border-dashed border-border bg-muted/10 p-10 text-center text-[13px] text-muted-foreground">
            No tasks match <span className="font-mono text-foreground/70">&quot;{query}&quot;</span>
          </div>
        )}
      </div>

      {/* Sticky bottom action bar */}
      {selected.size > 0 && (
        <SelectionActionBar
          selectedCount={selected.size}
          runRunning={runState.running}
          comparing={comparing}
          isDemoProject={isDemoProject}
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
