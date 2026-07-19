"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  fetchReadinessReport,
  fetchRuntimeConfig,
  type DatabaseDescriptor,
  type ReadinessReport,
  type RuntimeConfig,
} from "@/lib/system-api";
import { CheckCircle2, RefreshCw, ServerCog, XCircle } from "lucide-react";
import { toast } from "sonner";

export function SystemRuntimePanel({
  initialConfig = null,
  initialReadiness = null,
}: {
  initialConfig?: RuntimeConfig | null;
  initialReadiness?: ReadinessReport | null;
}) {
  const [config, setConfig] = useState<RuntimeConfig | null>(initialConfig);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(
    initialReadiness,
  );
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const [nextConfig, nextReadiness] = await Promise.allSettled([
        fetchRuntimeConfig(),
        fetchReadinessReport(),
      ]);
      if (nextConfig.status === "fulfilled") {
        setConfig(nextConfig.value);
      } else {
        toast.error("Failed to load runtime config");
      }
      if (nextReadiness.status === "fulfilled") {
        setReadiness(nextReadiness.value);
      } else {
        toast.error("Failed to load readiness report");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="border bg-card p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ServerCog className="h-4 w-4 text-primary" />
          <h2 className="text-[18px] font-semibold tracking-tight">
            Deployment Topology
          </h2>
          {config ? (
            <Badge variant="outline" className="ml-1">
              {config.supported_topology}
            </Badge>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      <p className="mb-4 text-[13px] text-muted-foreground">
        Single-node topology: one backend, one scheduler owner, one database.
        Multi-replica backends are explicitly unsupported.
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ConfigRow label="Topology" value={config?.supported_topology} />
        <ConfigRow
          label="Deployment profile"
          value={config?.deployment_profile}
          tone={
            config?.deployment_profile === "development" ? "warning" : "default"
          }
        />
        <ConfigRow
          label="Scheduler"
          value={formatScheduler(config?.scheduler_enabled)}
          tone={
            config?.scheduler_enabled === false ? "warning" : "default"
          }
        />
        <ConfigRow
          label="Execution mode"
          value={config?.task_execution_mode ?? undefined}
        />
        <ConfigRow
          label="Max concurrent batches"
          value={
            config?.max_concurrent_batches !== undefined
              ? String(config.max_concurrent_batches)
              : undefined
          }
        />
        <ConfigRow
          label="Public URL"
          value={config?.public_url}
          mono
        />
        <ConfigRow
          label="Backend URL"
          value={config?.backend_url}
          mono
        />
        <ConfigRow
          label="Frontend URL"
          value={config?.frontend_url}
          mono
        />
        <ConfigRow
          label="Database"
          value={formatDatabase(config?.database)}
          tone={
            config?.database && !config.database.shared_use_recommended
              ? "warning"
              : "default"
          }
        />
        <ConfigRow
          label="Task-source cache"
          value={config?.task_source_cache_dir}
          mono
        />
      </div>

      <div className="mt-6">
        <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
          Readiness
        </h3>
        <ReadinessGrid report={readiness} loading={loading} />
      </div>
    </section>
  );
}

function ConfigRow({
  label,
  value,
  mono = false,
  tone = "default",
}: {
  label: string;
  value: string | undefined;
  mono?: boolean;
  tone?: "default" | "warning";
}) {
  return (
    <div className="border bg-background/40 p-3">
      <div className="text-[12px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-1 truncate text-[13px] ${
          mono ? "font-mono" : ""
        } ${tone === "warning" ? "text-warning" : ""}`}
        title={value}
      >
        {value ?? "—"}
      </div>
    </div>
  );
}

function ReadinessGrid({
  report,
  loading,
}: {
  report: ReadinessReport | null;
  loading: boolean;
}) {
  if (loading && report === null) {
    return (
      <div className="text-[13px] text-muted-foreground">
        Checking readiness…
      </div>
    );
  }
  if (!report) {
    return (
      <div className="text-[13px] text-muted-foreground">
        Readiness unavailable.
      </div>
    );
  }
  const checks = Object.values(report.checks);
  if (checks.length === 0) {
    return null;
  }
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
      {checks.map((check) => (
        <div
          key={check.name}
          className="flex items-start gap-2 border bg-background/40 p-3 text-[13px]"
        >
          {check.ok ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          ) : (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          )}
          <div className="min-w-0">
            <div className="font-medium">{check.name}</div>
            {check.detail ? (
              <div className="mt-0.5 break-words text-muted-foreground">
                {check.detail}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatScheduler(enabled: boolean | undefined): string {
  if (enabled === undefined) return "—";
  return enabled ? "Enabled (single owner)" : "Disabled (no dispatch)";
}

function formatDatabase(db: DatabaseDescriptor | undefined | null): string {
  if (!db) return "—";
  const parts: string[] = [db.engine];
  if (db.host) parts.push(`@ ${db.host}`);
  if (db.name) parts.push(`/${db.name}`);
  if (db.credentials_configured) parts.push("(credentials set)");
  if (!db.shared_use_recommended && db.engine !== "unknown") {
    parts.push("[dev only — not recommended for shared use]");
  }
  return parts.join(" ");
}
