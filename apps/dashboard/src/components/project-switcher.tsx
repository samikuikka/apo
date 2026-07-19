"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { ChevronsUpDown, Plus, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { type Project, listProjects, createProject } from "@/lib/projects-api";

function setActiveProjectCookie(projectId: string) {
  document.cookie = `active-project=${projectId};path=/;max-age=604800;samesite=lax`;
}

export function ProjectSwitcher({ currentProjectId }: { currentProjectId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [projects, setProjects] = useState<Project[]>([]);
  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listProjects()
      .then((ps) => setProjects(ps.filter((p) => p.id !== "demo")))
      .catch(() => {});
  }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowCreate(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const current = projects.find((p) => p.id === currentProjectId);

  function switchTo(projectId: string) {
    setActiveProjectCookie(projectId);
    const newPath = pathname.replace(/\/project\/[^/]+/, `/project/${projectId}`);
    router.push(newPath);
    setOpen(false);
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    setLoading(true);
    try {
      const project = await createProject(newName.trim());
      setProjects((prev) => [project, ...prev]);
      setNewName("");
      setShowCreate(false);
      switchTo(project.id);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm font-semibold text-foreground transition-colors hover:bg-muted/40"
      >
        <span className="truncate text-foreground">{current?.name ?? currentProjectId}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-full min-w-[240px] rounded-md border border-border bg-popover p-1 shadow-md">
          {/* User's projects first */}
          {projects.length > 0 ? (
            <>
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => switchTo(p.id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted/40",
                    p.id === currentProjectId && "bg-muted/30 font-semibold",
                  )}
                >
                  <span className="truncate text-foreground">{p.name}</span>
                  {p.id === currentProjectId && <Check className="size-3.5 shrink-0 text-primary" />}
                </button>
              ))}
            </>
          ) : (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No projects yet</p>
          )}

          {/* Create new */}
          <div className="my-1 border-t border-border/50" />

          {showCreate ? (
            <div className="p-1">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="Project name"
                className="h-8 w-full rounded-sm border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={handleCreate}
                disabled={loading || !newName.trim()}
                className="mt-1 w-full rounded-sm bg-primary px-2 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {loading ? "Creating..." : "Create project"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted/40"
            >
              <Plus className="size-3.5" />
              New project
            </button>
          )}

          {/* Demo at the bottom */}
          <div className="my-1 border-t border-border/50" />
          <button
            type="button"
            onClick={() => switchTo("demo")}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted/40",
              "demo" === currentProjectId && "bg-muted/30 font-semibold",
            )}
          >
            <span className="truncate">Demo Project</span>
            {"demo" === currentProjectId && <Check className="size-3 shrink-0 text-primary" />}
          </button>
        </div>
      )}
    </div>
  );
}
