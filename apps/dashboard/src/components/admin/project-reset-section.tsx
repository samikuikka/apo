"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { listProjects, type Project } from "@/lib/projects-api";
import { backendFetch } from "@/lib/backend-fetch";
import { getBrowserBackendBaseUrl } from "@/lib/config";
import { Trash2, AlertTriangle } from "lucide-react";

export function ProjectResetSection() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState("");
  const [resetting, setResetting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    listProjects().then((ps) => {
      setProjects(ps);
      if (ps.length > 0) setSelected(ps[0]!.id);
    }).catch(() => {});
  }, []);

  async function handleReset() {
    if (!selected) return;
    setResetting(true);
    try {
      const res = await backendFetch(
        `${getBrowserBackendBaseUrl()}/v1/projects/${selected}/reset-data`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      const data = await res.json();
      toast.success(`Reset complete: ${JSON.stringify(data.deleted)}`);
      setConfirming(false);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 text-amber-500" />
        <h3 className="text-sm font-semibold">Reset project data</h3>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Deletes all traces, calls, batch runs, task runs, schedules, and sessions for the selected project. The project and its API keys are kept.
      </p>

      <div className="mt-3 flex items-center gap-2">
        <select
          value={selected}
          aria-label="Select project to reset"
          onChange={(e) => { setSelected(e.target.value); setConfirming(false); }}
          className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        {!confirming ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setConfirming(true)}
            disabled={!selected}
          >
            <Trash2 className="mr-1.5 size-3.5" />
            Reset data
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs text-amber-500">Are you sure?</span>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleReset}
              disabled={resetting}
            >
              {resetting ? "Deleting..." : "Yes, delete everything"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
