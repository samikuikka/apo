"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  fetchTaskRuntimeStatus,
  type AgentTaskRuntimeStatus,
} from "@/lib/system-api";
import { CheckCircle2, Cpu, RefreshCw, XCircle } from "lucide-react";
import { toast } from "sonner";

export function TaskRuntimeStatusPanel({
  initialStatus = null,
}: {
  initialStatus?: AgentTaskRuntimeStatus | null;
}) {
  const [status, setStatus] = useState<AgentTaskRuntimeStatus | null>(
    initialStatus,
  );
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const next = await fetchTaskRuntimeStatus();
      setStatus(next);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load task runtime";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="border bg-card p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-primary" />
          <h2 className="text-[18px] font-semibold tracking-tight">
            Agent Task Runtime
          </h2>
          {status ? (
            <Badge variant={status.available ? "default" : "destructive"}>
              {status.available ? "Available" : "Unavailable"}
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
        Backend container must include the packaged agent-task runtime so
        real tasks can execute without depending on dev-only tooling.
      </p>

      {status && status.available ? (
        <div className="flex items-start gap-2 border bg-background/40 p-3 text-[13px]">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <div className="font-medium">Runtime ready</div>
            <div className="mt-0.5 break-words font-mono text-muted-foreground">
              {status.node_version ?? "unknown node"} · {status.runner_path}
            </div>
          </div>
        </div>
      ) : null}

      {status && !status.available ? (
        <div className="flex items-start gap-2 border border-destructive/40 bg-destructive/5 p-3 text-[13px]">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <div className="font-medium text-destructive">
              Runtime unavailable
            </div>
            {status.error ? (
              <div className="mt-0.5 break-words text-muted-foreground">
                {status.error}
              </div>
            ) : null}
            <div className="mt-2 text-muted-foreground">
              Agent task runs will fail with an operator-grade error until the
              backend image includes the packaged runtime (SPEC-125).
            </div>
          </div>
        </div>
      ) : null}

      {status === null && !loading ? (
        <div className="text-[13px] text-muted-foreground">
          Status unavailable.
        </div>
      ) : null}
    </section>
  );
}
