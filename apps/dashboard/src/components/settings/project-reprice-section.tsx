"use client";

import { useEffect, useMemo, useState } from "react";
import { Coins, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { listProjects, type Project } from "@/lib/projects-api";
import { getRepriceJob, startProjectReprice, type RepriceSummary } from "@/lib/reprice-api";
import { Button } from "@/components/ui/button";

const POLL_MS = 2000;
const MAX_POLLS = 300;

/**
 * Recompute a project's stored call costs against the current price table.
 * Costs are frozen when a call is ingested, so a price correction only
 * reaches past runs through a reprice. Requires project owner/admin; the
 * demo workspace is read-only.
 */
export function ProjectRepriceSection() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [since, setSince] = useState("");
  const [running, setRunning] = useState<"dry" | "apply" | null>(null);
  const [result, setResult] = useState<{ dryRun: boolean; summary: RepriceSummary } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listProjects(controller.signal)
      .then((loaded) => {
        setProjects(loaded);
        if (loaded.length > 0 && loaded[0] !== undefined) {
          setSelectedId((prev) => prev ?? loaded[0]!.id);
        }
      })
      .catch(() => setProjects([]));
    return () => controller.abort();
  }, []);

  const selected = useMemo(
    () => projects?.find((p) => p.id === selectedId) ?? null,
    [projects, selectedId],
  );

  const canReprice =
    selected !== null &&
    selected.id !== "demo" &&
    (selected.current_user_role === "owner" || selected.current_user_role === "admin");

  async function run(dryRun: boolean) {
    if (!selected || !canReprice) return;
    setRunning(dryRun ? "dry" : "apply");
    setResult(null);
    try {
      const { job_id } = await startProjectReprice(selected.id, {
        since: since ? `${since}T00:00:00` : undefined,
        dryRun,
      });
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const job = await getRepriceJob(job_id);
        if (job.status === "error") throw new Error(job.error ?? "Reprice failed");
        if (job.status === "done" && job.summary) {
          setResult({ dryRun, summary: job.summary });
          toast.success(dryRun ? "Dry run finished — nothing was changed" : "Costs recomputed");
          return;
        }
      }
      throw new Error("Reprice is still running — check back later");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Reprice failed");
    } finally {
      setRunning(null);
    }
  }

  if (projects === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading projects…
      </div>
    );
  }
  if (projects.length === 0) {
    return <p className="text-sm text-muted-foreground">No projects yet.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-6">
        <div>
          <label htmlFor="reprice-project" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Project
          </label>
          <select
            id="reprice-project"
            value={selectedId ?? undefined}
            onChange={(e) => {
              setSelectedId(e.target.value);
              setResult(null);
            }}
            className="mt-1.5 block w-full max-w-sm border border-border bg-card px-2.5 py-2 text-sm text-foreground"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="reprice-since" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Calls since (optional)
          </label>
          <input
            id="reprice-since"
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="mt-1.5 block h-9 border border-border bg-card px-2.5 text-sm tabular-nums"
          />
        </div>
      </div>

      {selected?.id === "demo" && <p className="text-xs text-muted-foreground">Demo workspace is read-only.</p>}
      {selected && selected.id !== "demo" && !canReprice && (
        <p className="text-xs text-muted-foreground">Recomputing costs requires project admin.</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => run(true)} disabled={!canReprice || running !== null} className="gap-1.5">
          {running === "dry" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Dry run
        </Button>
        <Button type="button" onClick={() => run(false)} disabled={!canReprice || running !== null} className="gap-1.5">
          {running === "apply" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Coins className="h-3.5 w-3.5" />}
          Recompute costs
        </Button>
      </div>

      {result && (
        <div className="max-w-xl border border-border bg-card px-4 py-3 text-sm">
          <p className="font-medium">
            {result.dryRun ? "Dry run — nothing was written" : "Stored costs updated"}
          </p>
          <p className="mt-1 text-muted-foreground tabular-nums">
            {result.summary.repriced} call{result.summary.repriced === 1 ? "" : "s"} repriced, net change{" "}
            {formatUsd(result.summary.net_delta)}
            {result.dryRun ? "" : ` across ${result.summary.refreshed_runs.length} run${result.summary.refreshed_runs.length === 1 ? "" : "s"}`}
            .
          </p>
          {result.summary.skipped_no_match > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {result.summary.skipped_no_match} call{result.summary.skipped_no_match === 1 ? " has" : "s have"} no matching price and stayed unpriced.
            </p>
          )}
        </div>
      )}

      <p className="max-w-xl text-xs text-muted-foreground">
        Costs are fixed when a call is recorded. After a price-table correction, recompute to bring
        this project&apos;s past runs in line. Calls whose cost was supplied by the caller are left alone.
      </p>
    </div>
  );
}

function formatUsd(micro: number): string {
  const usd = micro / 1_000_000;
  const sign = usd > 0 ? "+" : usd < 0 ? "−" : "";
  return `${sign}$${Math.abs(usd).toFixed(2)}`;
}
