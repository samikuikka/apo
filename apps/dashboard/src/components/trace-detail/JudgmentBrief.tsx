"use client";

import { cn } from "@/lib/utils";
import type { LoggedCall } from "./contexts";
import { judgmentFacts } from "./trace-evaluation";
import { formatDuration } from "@/lib/format";

/**
 * The judgment brief: rendered above the tabs when the selected call is a
 * judge/t.agent root. Answers "what was judged, by what, and why did it
 * rule" without opening the raw JSON tabs. Chosen (variant "verdict card")
 * over a two-column dossier and a one-line ruling after live review — see
 * the fold-in commit for the recorded verdict.
 */
export function JudgmentBrief({
  call,
  allCalls,
  loading,
}: {
  call: LoggedCall;
  allCalls: LoggedCall[];
  /** Slim-payload phase: facts live in the full call, fetched on demand. */
  loading: boolean;
}) {
  const facts = judgmentFacts(call, allCalls);
  if (!facts || loading) return null;

  return (
    <div className="shrink-0 border-b border-border bg-muted/15 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            facts.pass === true && "bg-success/15 text-success",
            facts.pass === false && "bg-destructive/15 text-destructive",
            facts.pass === undefined && "bg-muted text-muted-foreground",
          )}
        >
          {facts.pass === true ? "pass" : facts.pass === false ? "fail" : "—"}
        </span>
        <span className="truncate text-sm font-medium text-foreground">{facts.name}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
          {facts.model ?? "?"}
          {facts.latencyMs != null ? ` · ${formatDuration(facts.latencyMs)}` : ""}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 text-xs leading-relaxed">
        <div>
          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Instruction to the judge
          </div>
          <p className="text-foreground/90">{facts.instruction ?? "—"}</p>
        </div>
        <div>
          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Why it ruled this way
          </div>
          <p className={cn(facts.pass === false ? "text-destructive" : "text-foreground/90")}>
            {facts.reasoning ?? "—"}
          </p>
        </div>
      </div>
    </div>
  );
}
