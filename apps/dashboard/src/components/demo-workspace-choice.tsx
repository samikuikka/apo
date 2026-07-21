"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Sparkles, ArrowRight, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { enterDemo } from "@/lib/demo-workspace";
import { createProject } from "@/lib/projects-api";
import { isApiError } from "@/lib/api-error";

export function DemoWorkspaceChoice() {
  const router = useRouter();
  const { status } = useSession();
  const [seeding, setSeeding] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const loading = status === "loading";

  const isAuthenticated = status === "authenticated";

  async function handleDemo() {
    setSeeding(true);
    try {
      const { backendFetch } = await import("@/lib/backend-fetch");
      const { getBrowserBackendBaseUrl } = await import("@/lib/config");
      await backendFetch(`${getBrowserBackendBaseUrl()}/v1/demo/seed`, { method: "POST" });
    } catch {
      // ignore — may already be seeded
    }
    enterDemo();
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const project = await createProject(newName.trim());
      router.push(`/project/${project.id}/tasks`);
    } catch (error) {
      setCreating(false);
      // Surface the real failure instead of silently stopping the spinner.
      // The backend returns detail for validation/auth errors; a missing
      // message usually means a proxy/transport problem (e.g. 404 HTML),
      // so fall back to a generic but actionable string.
      toast.error(
        isApiError(error)
          ? error.message
          : error instanceof Error
            ? error.message
            : "Failed to create project",
      );
    }
  }

  if (loading || seeding) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-4 px-6 py-16">
      {/* Demo workspace */}
      <button
        type="button"
        onClick={handleDemo}
        className="group flex w-full items-center gap-3 rounded-lg border border-border/60 bg-card p-4 text-left transition-all hover:border-border hover:bg-muted/30"
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Sparkles className="size-4 text-primary" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold">Try the demo workspace</div>
          <div className="text-xs text-muted-foreground">
            Explore apo with pre-loaded tasks, runs, and traces.
          </div>
        </div>
        <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </button>

      {/* Sign in / Create */}
      {!isAuthenticated ? (
        <button
          type="button"
          onClick={() => router.push("/login")}
          className="group flex w-full items-center gap-3 rounded-lg border border-border/60 bg-card p-4 text-left transition-all hover:border-border hover:bg-muted/30"
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/40">
            <ArrowRight className="size-4 text-muted-foreground" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold">Sign in</div>
            <div className="text-xs text-muted-foreground">
              Create an account to run your own tasks and manage projects.
            </div>
          </div>
          <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </button>
      ) : (
        <div className="rounded-lg border border-border/60 bg-card p-4">
          {showCreate ? (
            <div className="space-y-2">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="Project name"
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
                className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {creating ? "Creating..." : "Create project"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="flex w-full items-center gap-3 text-left"
            >
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <Plus className="size-4 text-primary" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold">Create your first project</div>
                <div className="text-xs text-muted-foreground">
                  Start running agent tasks and collecting traces.
                </div>
              </div>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
