"use client";

import { Loader2, AlertCircle, Check, Clock, CircleDashed } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ProjectTaskSourceStatus } from "@/lib/projects-api";

interface TaskSourceStatusBadgeProps {
  status: ProjectTaskSourceStatus;
  className?: string;
}

interface StatusConfig {
  label: string;
  variant: React.ComponentProps<typeof Badge>["variant"];
  icon: React.ComponentType<{ className?: string }>;
  dotClassName: string;
}

const STATUS_CONFIG: Record<ProjectTaskSourceStatus, StatusConfig> = {
  unconfigured: {
    label: "Not configured",
    variant: "outline",
    icon: CircleDashed,
    dotClassName: "text-muted-foreground",
  },
  pending_sync: {
    label: "Pending sync",
    variant: "secondary",
    icon: Clock,
    dotClassName: "text-warning",
  },
  syncing: {
    label: "Syncing",
    variant: "secondary",
    icon: Loader2,
    dotClassName: "text-muted-foreground",
  },
  ready: {
    label: "Ready",
    variant: "secondary",
    icon: Check,
    dotClassName: "text-success",
  },
  error: {
    label: "Sync failed",
    variant: "destructive",
    icon: AlertCircle,
    dotClassName: "text-destructive",
  },
};

export function TaskSourceStatusBadge({
  status,
  className,
}: TaskSourceStatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.unconfigured;
  const Icon = config.icon;
  const isSyncing = status === "syncing";

  return (
    <Badge variant={config.variant} className={cn("gap-1", className)}>
      <Icon
        className={cn("size-3", config.dotClassName, isSyncing && "animate-spin")}
      />
      {config.label}
    </Badge>
  );
}
