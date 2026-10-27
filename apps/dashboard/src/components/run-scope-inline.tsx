import { Fragment, type ReactNode } from "react";

import type { RunLabels } from "@/lib/agent-task-api";

/**
 * A run's environment and labels as inline meta items, each preceded by the
 * host line's own separator. A label shows its name; its key and id are in
 * the tooltip, since the id is what the filters match.
 */
export function RunScopeInline({
  environment,
  labels,
  separator,
}: {
  environment: string | null;
  labels: RunLabels;
  separator: ReactNode;
}) {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return (
    <>
      {environment && (
        <>
          {separator}
          <span className="shrink-0 font-mono" title={`environment: ${environment}`}>
            {environment}
          </span>
        </>
      )}
      {entries.map(([key, label]) => (
        <Fragment key={key}>
          {separator}
          <span className="min-w-0 shrink truncate" title={`${key}: ${label.name} (${label.id})`}>
            <span className="text-muted-foreground/60">{key}</span> {label.name}
          </span>
        </Fragment>
      ))}
    </>
  );
}
