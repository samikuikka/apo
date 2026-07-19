"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";
import { type ProjectTaskSource } from "@/lib/projects-api";
import { ProjectTaskSourceForm } from "./ProjectTaskSourceForm";
import { ProjectTaskSourceStatusPanel } from "./ProjectTaskSourceStatusPanel";

interface ProjectTaskSourceSetupCardProps {
  projectId: string;
  taskSource: ProjectTaskSource | null;
  isDemo: boolean;
  /**
   * When true, the card renders even if the project has a configured
   * source. Useful for the tasks page where the setup state is the
   * primary surface until tasks actually exist.
   */
  forceShowWhenConfigured?: boolean;
  /**
   * When true, skip the status panel and jump straight to the form.
   * Used when the parent already decided the user wants to edit.
   */
  startInEdit?: boolean;
  /**
   * Called when a sync completes successfully (status becomes
   * "ready"). Parent uses this to auto-close the edit panel and
   * show the task list.
   */
  onSynced?: () => void;
  className?: string;
}

type Mode = "status" | "edit";

export function ProjectTaskSourceSetupCard({
  projectId,
  taskSource,
  isDemo,
  forceShowWhenConfigured = false,
  startInEdit = false,
  onSynced,
  className,
}: ProjectTaskSourceSetupCardProps) {
  const [mode, setMode] = useState<Mode>(startInEdit ? "edit" : "status");

  // Local copy of taskSource that we can update immediately when the
  // form saves — without waiting for router.refresh() to round-trip
  // through the server. This prevents the "stuck on stale data"
  // problem where the StatusPanel showed old props for 1-2 seconds
  // after a save.
  const [localSource, setLocalSource] = useState<ProjectTaskSource | null>(
    taskSource,
  );

  // Sync from prop when the parent re-renders with fresh server data
  // (e.g. after router.refresh() completes) — without the stale-first-render
  // flash of a useEffect-based mirror.
  const [prevTaskSource, setPrevTaskSource] = useState(taskSource);
  if (taskSource !== prevTaskSource) {
    setPrevTaskSource(taskSource);
    setLocalSource(taskSource);
  }

  // When the project has no source, force the form. Otherwise default
  // to the status panel and let the user opt into editing.
  const editing = mode === "edit";
  const showForm =
    localSource === null || editing || forceShowWhenConfigured;

  return (
    <section
      className={cn(
        "mx-auto flex w-full max-w-2xl flex-col gap-6 border-b border-border px-6 py-8",
        className,
      )}
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-[18px] font-semibold tracking-tight">
          {localSource ? "Task source" : "Connect a task source"}
        </h1>
        {!localSource && (
          <p className="text-xs text-muted-foreground">
            Sync agent tasks from a Git repository or a local folder.
          </p>
        )}
      </header>

      {showForm || localSource === null ? (
        <ProjectTaskSourceForm
          projectId={projectId}
          initialValue={localSource}
          onSaved={(updated) => {
            // Immediately update local state so the StatusPanel
            // renders the fresh data without waiting for server refresh.
            setLocalSource(updated);
            setMode("status");
            // If the source is already "ready" (form chained save+sync),
            // auto-close the panel so the user sees the task list.
            if (updated.status === "ready") {
              onSynced?.();
            }
          }}
        />
      ) : (
        <ProjectTaskSourceStatusPanel
          projectId={projectId}
          taskSource={localSource}
          isDemo={isDemo}
          onEdit={() => setMode("edit")}
          onSynced={onSynced}
        />
      )}
    </section>
  );
}
