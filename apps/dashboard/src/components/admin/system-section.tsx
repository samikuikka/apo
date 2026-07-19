"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { backendFetch } from "@/lib/backend-fetch";
import { toast } from "sonner";
import Link from "next/link";
import { AlertTriangle, Database, FlaskConical, Settings, Workflow } from "lucide-react";

interface DbStats {
  [key: string]: number;
}

export function SystemSection({ initialStats = null }: { initialStats?: DbStats | null }) {
  const [stats, setStats] = useState<DbStats | null>(initialStats);
  const [loading, setLoading] = useState(false);
  const [confirmNuke, setConfirmNuke] = useState("");

  const fetchStats = async () => {
    setLoading(true);
    try {
      const res = await backendFetch(
        "/backend-proxy/v1/admin/stats?admin_key=dev-admin-key-only",
      );
      if (!res.ok) throw new Error("Failed to fetch stats");
      const data = await res.json();
      setStats(data.stats);
    } catch (e: any) {
      toast.error(e.message || "Failed to fetch stats");
    } finally {
      setLoading(false);
    }
  };

  const resetDatabase = async () => {
    if (!confirm("Are you sure you want to reset the database? This will delete ALL data.")) return;
    setLoading(true);
    try {
      const res = await backendFetch(
        "/backend-proxy/v1/admin/reset-db?admin_key=dev-admin-key-only",
        { method: "POST" },
      );
      if (!res.ok) throw new Error("Failed to reset database");
      toast.success((await res.json()).message);
      fetchStats();
    } catch (e: any) {
      toast.error(e.message || "Failed to reset database");
    } finally {
      setLoading(false);
    }
  };

  const nukeDatabase = async () => {
    if (confirmNuke !== "YES_I_AM_SURE") {
      toast.error('You must type "YES_I_AM_SURE" to confirm');
      return;
    }
    if (!confirm("FINAL WARNING: This will completely delete and recreate the database file. Continue?")) return;
    setLoading(true);
    try {
      const res = await backendFetch(
        "/backend-proxy/v1/admin/nuke-db?admin_key=dev-admin-key-only&confirm=YES_I_AM_SURE",
        { method: "POST" },
      );
      if (!res.ok) throw new Error("Failed to nuke database");
      toast.success((await res.json()).message);
      setConfirmNuke("");
      fetchStats();
    } catch (e: any) {
      toast.error(e.message || "Failed to nuke database");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-full bg-background text-foreground">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Settings className="h-4 w-4 text-primary" />
                <h1 className="text-[18px] font-semibold tracking-tight">Admin</h1>
              </div>
              <p className="mt-1 max-w-2xl text-[13px] text-muted-foreground">
                Internal system operations for the agent-testing platform. This surface is operational only,
                not part of the primary product workflow for tasks, runs, or traces.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" asChild variant="outline" size="sm" className="h-8 text-[13px] font-normal">
                <Link href="/tasks">
                  <FlaskConical className="mr-1.5 h-3.5 w-3.5" />
                  Tasks
                </Link>
              </Button>
              <Button type="button" asChild variant="outline" size="sm" className="h-8 text-[13px] font-normal">
                <Link href="/traces">
                  <Workflow className="mr-1.5 h-3.5 w-3.5" />
                  Traces
                </Link>
              </Button>
            </div>
          </div>

          <div className="border border-warning bg-warning/10 px-4 py-3 text-[13px] text-warning">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                These controls are destructive operational tools. Use them for local recovery or development,
                not normal task, run, or trace surfaces.
              </p>
            </div>
          </div>

          <div className="border bg-card p-6">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-primary" />
                <h2 className="text-[18px] font-semibold">Database Statistics</h2>
              </div>
              <Button type="button" onClick={fetchStats} disabled={loading} variant="outline" size="sm">
                Refresh
              </Button>
            </div>
            {stats ? (
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                {Object.entries(stats).map(([table, count]) => (
                  <div key={table} className="border p-3">
                    <div className="text-sm text-muted-foreground">{table}</div>
                    <div className="text-[18px] font-semibold">{count}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-muted-foreground">No stats available.</div>
            )}
          </div>

          <div className="border border-destructive bg-card p-6">
            <h2 className="mb-2 text-[18px] font-semibold text-destructive">Reset Database</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              Delete all data from all tables. The database structure remains intact.
            </p>
            <Button type="button" onClick={resetDatabase} disabled={loading} variant="destructive">
              Reset Database
            </Button>
          </div>

          <div className="border border-destructive bg-destructive/5 p-6">
            <h2 className="mb-2 text-[18px] font-semibold text-destructive">
              Nuke Database
            </h2>
            <p className="mb-4 text-sm text-muted-foreground">
              Completely delete and recreate the database file. This is the most destructive
              operation. Type &quot;YES_I_AM_SURE&quot; to confirm.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                type="text"
                value={confirmNuke}
                onChange={(e) => setConfirmNuke(e.target.value)}
                placeholder='Type "YES_I_AM_SURE"'
                aria-label="Confirm database nuke"
                className="flex h-10 w-full border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-xs"
              />
              <Button type="button"
                onClick={nukeDatabase}
                disabled={loading || confirmNuke !== "YES_I_AM_SURE"}
                variant="destructive"
              >
                Nuke Database
              </Button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
