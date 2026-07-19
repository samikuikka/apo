"use client";

import { useReducer, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, AlertCircle, Pencil } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  type ProjectTaskSource,
  syncProjectTaskSource,
} from "@/lib/projects-api";
import { TaskSourceStatusBadge } from "./TaskSourceStatusBadge";

type SyncState =
  | { kind: "idle" }
  | { kind: "syncing" }
  | { kind: "error"; message: string };

type SyncAction =
  | { type: "START_SYNC" }
  | { type: "FINISH_SYNC" }
  | { type: "ERROR"; message: string };

function syncReducer(state: SyncState, action: SyncAction): SyncState {
  switch (action.type) {
    case "START_SYNC":
      return { kind: "syncing" };
    case "FINISH_SYNC":
      return { kind: "idle" };
    case "ERROR":
      return { kind: "error", message: action.message };
  }
}

interface ProjectTaskSourceStatusPanelProps {
  projectId: string;
  taskSource: ProjectTaskSource;
  isDemo: boolean;
  onEdit?: () => void;
  /** Called when sync completes successfully. */
  onSynced?: () => void;
}

export function ProjectTaskSourceStatusPanel({
  projectId,
  taskSource,
  isDemo,
  onEdit,
  onSynced,
}: ProjectTaskSourceStatusPanelProps) {
  const router = useRouter();
  const [syncState, dispatchSync] = useReducer(syncReducer, {
    kind: "idle",
  });

  // Local copy that we update immediately from API responses so the
  // UI doesn't wait for router.refresh() to show the new status.
  const [localSource, setLocalSource] = useState(taskSource);
  // Reset when the prop changes (e.g. after a parent router.refresh) without the
  // stale-first-render flash of a useEffect-based mirror.
  const [prevTaskSource, setPrevTaskSource] = useState(taskSource);
  if (taskSource !== prevTaskSource) {
    setPrevTaskSource(taskSource);
    setLocalSource(taskSource);
  }

  const syncing = syncState.kind === "syncing";
  const sourceIsSyncing = syncing || localSource.status === "syncing";
  const errorMessage =
    syncState.kind === "error" ? syncState.message : localSource.last_error;

  async function handleSync() {
    if (syncing || isDemo) return;
    dispatchSync({ type: "START_SYNC" });
    try {
      const result = await syncProjectTaskSource(projectId);
      setLocalSource(result);
      toast.success("Task source synced");
      dispatchSync({ type: "FINISH_SYNC" });
      // Notify parent so the edit panel can auto-close and the
      // task list can appear with the freshly synced tasks.
      if (result.status === "ready") {
        onSynced?.();
      }
      router.refresh();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Sync failed. Please try again.";
      dispatchSync({ type: "ERROR", message });
      toast.error("Sync failed");
    }
  }

  const ctaLabel = localSource.status === "ready" ? "Resync tasks" : "Sync tasks";

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{localSource.display_name}</h2>
          <TaskSourceStatusBadge status={localSource.status} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isDemo && onEdit && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onEdit}
              disabled={syncing}
            >
              <Pencil className="size-3.5" />
              Edit
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            onClick={handleSync}
            disabled={syncing || isDemo}
            title={
              isDemo
                ? "Demo workspace is read-only"
                : localSource.status === "syncing"
                  ? "Sync already in progress"
                  : undefined
            }
          >
            <RefreshCw
              className={cn("size-3.5", sourceIsSyncing && "animate-spin")}
            />
            {sourceIsSyncing ? "Syncing…" : ctaLabel}
          </Button>
        </div>
      </header>

      {/* Compact meta — one line that captures where tasks come from.
          Only adds a second line for sync provenance when a sync has
          actually happened. Empty values stay hidden instead of
          rendering as "—" noise. */}
      <div className="flex flex-col gap-1 font-mono text-[11px] text-muted-foreground">
        <div className="break-all">
          {sourceLocationLabel(localSource)}
        </div>
        {localSource.last_synced_at && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span>
              synced {formatRelative(localSource.last_synced_at)}
            </span>
            {localSource.last_resolved_commit_sha && (
              <span className="text-foreground/60">
                @{shortSha(localSource.last_resolved_commit_sha)}
              </span>
            )}
          </div>
        )}
        {!localSource.last_synced_at && localSource.status === "pending_sync" && (
          <span className="text-muted-foreground/70">
            not synced yet — click Sync tasks to pull from this source
          </span>
        )}
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="flex items-start gap-2 border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive"
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <div className="flex-1">
            <p className="font-medium">Sync failed</p>
            <p className="mt-0.5 break-words">{errorMessage}</p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Build a single readable "where am I syncing from" label per source.
 * For git sources this collapses repository + ref + subpath into one
 * short string. For filesystem/demo sources it returns the path/seed.
 */
function sourceLocationLabel(source: ProjectTaskSource): string {
  if (source.source_type === "git") {
    const repo = source.repository_url
      ? source.repository_url.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "")
      : "?";
    const ref = source.git_ref || "main";
    const subpath = source.subpath ? ` · ${source.subpath}` : "";
    return `${repo} @ ${ref}${subpath}`;
  }
  if (source.source_type === "filesystem") {
    return source.filesystem_path || "(no path)";
  }
  return `demo · ${source.demo_seed_id ?? "example-service"}`;
}

function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

function formatRelative(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const diffMs = Date.now() - parsed.getTime();
  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return parsed.toLocaleDateString("en-US", { timeZone: "UTC" });
}
