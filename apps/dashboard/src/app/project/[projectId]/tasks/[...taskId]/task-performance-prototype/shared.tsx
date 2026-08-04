import { AlertTriangle, Check, X } from "lucide-react";
import type { PrototypeRun, PrototypeRunStatus } from "./data";

export function StatusMark({ status, size = "md" }: { status: PrototypeRunStatus; size?: "sm" | "md" }) {
  const dimensions = size === "sm" ? "h-5 w-5" : "h-7 w-7";
  if (status === "passed") {
    return <span className={`flex ${dimensions} items-center justify-center border border-success/40 bg-success/10 text-success`}><Check className="h-3.5 w-3.5" /></span>;
  }
  if (status === "error") {
    return <span className={`flex ${dimensions} items-center justify-center border border-warning/40 bg-warning/10 text-warning`}><AlertTriangle className="h-3.5 w-3.5" /></span>;
  }
  return <span className={`flex ${dimensions} items-center justify-center border border-destructive/40 bg-destructive/10 text-destructive`}><X className="h-3.5 w-3.5" /></span>;
}

export function DefinitionBadge({ run }: { run: PrototypeRun }) {
  if (run.definition === "working") {
    return <span className="border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] text-warning">WORKING {run.definitionDigest}</span>;
  }
  return (
    <span className={`border px-1.5 py-0.5 font-mono text-[10px] ${run.baseline ? "border-foreground/20 text-foreground" : "border-border text-muted-foreground"}`}>
      {run.definition.toUpperCase()} {run.definitionDigest}
    </span>
  );
}

export function formatModel(model: PrototypeRun["model"]) {
  return model.replace("Claude ", "");
}

export function statusColor(status: PrototypeRunStatus) {
  if (status === "passed") return "bg-success";
  if (status === "error") return "bg-warning";
  return "bg-destructive";
}
