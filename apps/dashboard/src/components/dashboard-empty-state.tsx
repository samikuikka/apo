"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { ArrowRight, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { createProject } from "@/lib/projects-api";
import { isApiError } from "@/lib/api-error";

/**
 * The authenticated-empty home state: create your first project, or step
 * into the demo workspace first to see what a populated apo looks like.
 */
export function DashboardEmptyState() {
  const router = useRouter();
  const { status } = useSession();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const project = await createProject(newName.trim());
      router.push(`/project/${project.id}/tasks`);
    } catch (error) {
      setCreating(false);
      // Surface the real failure instead of silently stopping the spinner.
      toast.error(
        isApiError(error)
          ? error.message
          : error instanceof Error
            ? error.message
            : "Failed to create project",
      );
    }
  }

  if (status === "loading") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-background px-6 py-10">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-[520px] flex-col items-center justify-center">
        <div className="w-full border border-border bg-card p-4">
          {showCreate ? (
            <div className="space-y-2">
              <label
                htmlFor="demo-project-name"
                className="block text-xs text-muted-foreground"
              >
                Project name
              </label>
              <input
                id="demo-project-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="Project name"
                className="h-9 w-full border border-border bg-input/30 px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <button
                type="button"
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
                className="h-9 w-full bg-foreground px-3 text-sm font-medium text-background disabled:opacity-50"
              >
                {creating ? "Creating…" : "Create project"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="flex w-full items-center gap-3 text-left"
            >
              <span className="flex size-9 shrink-0 items-center justify-center bg-muted">
                <Plus className="size-4" />
              </span>
              <span className="flex-1">
                <span className="block text-sm font-semibold">
                  Create your first project
                </span>
                <span className="block text-xs text-muted-foreground">
                  Start running agent tasks and collecting traces.
                </span>
              </span>
            </button>
          )}
        </div>
        <Link
          href="/project/demo/tasks"
          className="mt-3 flex w-full items-center gap-3 px-1 py-2 text-left text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="flex-1">
            <span className="block text-sm font-medium">
              Or explore the demo workspace
            </span>
            <span className="block text-xs text-muted-foreground/70">
              Captured example runs — every failure with its evidence.
            </span>
          </span>
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </main>
  );
}
