"use client";

import { Terminal } from "lucide-react";
import type { AgentJudgeSession } from "@/lib/agent-task-api";

/**
 * The agentic judge's investigation, collapsed by default: one row per step
 * with the tools it called, plus the session summary (outcome, steps,
 * evidence reads, tokens). The verdict reasoning stays the drawer's primary
 * text — this is the audit trail behind it.
 */
export function AgentSessionTimeline({ session }: { session: AgentJudgeSession }) {
  const steps = session.steps ?? [];
  const evidenceReads = session.evidence?.length ?? 0;
  const tokens = session.usage?.input_tokens ?? session.usage?.output_tokens
    ? `${session.usage?.input_tokens ?? 0} in / ${session.usage?.output_tokens ?? 0} out`
    : null;

  return (
    <details className="group rounded-sm border border-border bg-muted/20">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-muted-foreground marker:hidden">
        <Terminal className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="font-medium text-foreground">
          Investigation — {steps.length} step{steps.length === 1 ? "" : "s"}, {evidenceReads} evidence read
          {evidenceReads === 1 ? "" : "s"}
        </span>
        <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[11px] uppercase">
          {(session.outcome ?? "unknown").replace("_", " ")}
        </span>
        {tokens && <span className="ml-auto font-mono text-[11px]">{tokens}</span>}
      </summary>
      <ol className="space-y-1 border-t border-border px-3 py-2">
        {steps.map((step, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[11px]">
            <span className="text-muted-foreground">{String(step.index).padStart(2, "0")}</span>
            {(step.tool_calls ?? []).map((call, i) => (
              <span key={i} className="text-foreground">
                {call.name}
                <span className="text-muted-foreground">
                  ({truncateOneLine(call.input)})
                </span>
              </span>
            ))}
            {step.text && !step.tool_calls?.length && (
              <span className="text-muted-foreground">{truncateOneLine(step.text)}</span>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

function truncateOneLine(text: string | undefined): string {
  if (!text) return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 48)}…` : oneLine;
}
