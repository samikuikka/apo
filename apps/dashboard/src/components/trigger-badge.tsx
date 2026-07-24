import { GitBranch, GitCommit, GitPullRequest, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentTaskRunTrigger } from "@/lib/agent-task-api";

const SOURCE_STYLES: Record<string, { bg: string; text: string }> = {
  ci: { bg: "bg-purple-500/10", text: "text-purple-400" },
  cli: { bg: "bg-foreground/5", text: "text-foreground" },
  schedule: { bg: "bg-foreground/5", text: "text-foreground" },
  api: { bg: "bg-foreground/5", text: "text-foreground" },
  manual: { bg: "bg-foreground/5", text: "text-foreground" },
};

function SourceBadge({ source }: { source: string }) {
  const style = SOURCE_STYLES[source] ?? SOURCE_STYLES.api;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
        style.bg,
        style.text,
      )}
    >
      {source === "ci" && <Workflow className="h-2.5 w-2.5" />}
      {source}
    </span>
  );
}

export function TriggerBadge({ trigger }: { trigger: AgentTaskRunTrigger | null }) {
  if (!trigger?.source) {
    return (
      <span className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        Batch
      </span>
    );
  }

  if (trigger.source === "ci") {
    return (
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
        <SourceBadge source="ci" />
        {trigger.repository && (
          <span className="inline-flex min-w-0 items-center gap-0.5 text-[11px] text-muted-foreground">
            <GitBranch className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{trigger.repository}</span>
          </span>
        )}
        {trigger.pr_number && (
          <a
            href={`https://github.com/${trigger.repository}/pull/${trigger.pr_number}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-purple-400 hover:text-purple-300"
          >
            <GitPullRequest className="h-2.5 w-2.5" />
            #{trigger.pr_number}
          </a>
        )}
        {trigger.commit_sha && (
          <span className="inline-flex shrink-0 items-center gap-0.5 font-mono text-[11px] text-muted-foreground">
            <GitCommit className="h-2.5 w-2.5" />
            {trigger.commit_sha.slice(0, 7)}
          </span>
        )}
        {trigger.actor && (
          <span className="shrink-0 text-[11px] text-muted-foreground">{trigger.actor}</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <SourceBadge source={trigger.source} />
      {trigger.actor && (
        <span className="truncate text-[12px] text-muted-foreground">{trigger.actor}</span>
      )}
    </div>
  );
}

export function TriggerInline({ trigger }: { trigger: AgentTaskRunTrigger | null }) {
  if (!trigger?.source) return null;

  if (trigger.source === "ci") {
    const parts: string[] = ["ci"];
    if (trigger.ci_system) parts[0] = trigger.ci_system;
    if (trigger.repository) parts.push(trigger.repository);
    if (trigger.pr_number) parts.push(`#${trigger.pr_number}`);
    if (trigger.commit_sha) parts.push(trigger.commit_sha.slice(0, 7));
    return <span className="text-purple-400">{parts.join(" · ")}</span>;
  }

  if (trigger.source === "schedule") {
    const parts = ["schedule", trigger.schedule_name].filter(
      (value): value is string => Boolean(value),
    );
    return <span>{parts.join(" · ")}</span>;
  }

  const parts = [trigger.source, trigger.actor].filter(
    (value): value is string => Boolean(value),
  );
  return <span>{parts.join(" · ")}</span>;
}
