// PROTOTYPE — shared status chips for the monitors page prototype.

import { Badge } from "@/components/ui/badge";
import type { MonitorStub } from "./monitors-data";

export function MonitorStateChip({ monitor }: { monitor: MonitorStub }) {
  if (monitor.breached) {
    return <Badge variant="destructive">Breached</Badge>;
  }
  if (monitor.lifecycle === "paused") {
    return <Badge variant="outline">Paused</Badge>;
  }
  if (monitor.lifecycle === "draft") {
    return (
      <Badge variant="outline" className="border-dashed text-muted-foreground">
        Draft
      </Badge>
    );
  }
  return <Badge variant="secondary">Deployed</Badge>;
}

/** Square status marker — square corners are the app identity, so no dots. */
export function MonitorStateDot({ monitor }: { monitor: MonitorStub }) {
  const color = monitor.breached
    ? "bg-destructive"
    : monitor.lifecycle === "deployed"
      ? "bg-success"
      : monitor.lifecycle === "paused"
        ? "bg-muted-foreground/50"
        : "border border-muted-foreground/60";
  return <span aria-hidden className={`size-1.5 shrink-0 ${color}`} />;
}
