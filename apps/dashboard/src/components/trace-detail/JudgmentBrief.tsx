"use client";

// ── PROTOTYPE (throwaway): judgment detail variants ──────────────────────
// Question: when you open a judge/t.agent span in the trace detail pane, how
// should "what was judged, by what, and why it ruled" be presented so you
// don't read raw JSON? Three structurally different briefs, switchable via
// ?detail=a|b|c on the existing trace route (default = current behavior).
// Verdict captured in the worktree NOTES; losers get deleted.
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { LoggedCall } from "./contexts";
import { isEvaluationRoot } from "./trace-evaluation";
import { formatDuration } from "@/lib/format";

interface JudgmentFacts {
  name: string;
  kind: "t.judge" | "t.agent";
  model?: string;
  instruction?: string;
  reasoning?: string;
  pass?: boolean;
  toolChildren: number;
  latencyMs?: number | null;
}

function judgmentFacts(call: LoggedCall, allCalls: LoggedCall[]): JudgmentFacts | null {
  const step = call.step_name ?? "";
  if (!isEvaluationRoot(step)) return null;
  const sys = (call.input as { messages?: Array<{ role: string; content: unknown }> } | null)
    ?.messages?.find((m) => m.role === "system")?.content;
  let model: string | undefined;
  let instruction: string | undefined;
  if (typeof sys === "string") {
    try {
      const parsed = JSON.parse(sys) as { model?: string; instruction?: string };
      model = parsed.model;
      instruction = parsed.instruction;
    } catch {
      // system prompt isn't the {model, instruction} JSON — leave undefined
    }
  }
  const verdict = call.tool_result as { pass?: boolean; reasoning?: string } | null;
  return {
    name: step.replace(/^(judge|t\.agent):/, ""),
    kind: step.startsWith("t.agent") ? "t.agent" : "t.judge",
    model,
    instruction,
    reasoning: verdict?.reasoning,
    pass: verdict?.pass,
    toolChildren: allCalls.filter((c) => c.parent_call_id === call.id).length,
    latencyMs: call.latency_ms,
  };
}

function VerdictPill({ pass, size = "sm" }: { pass: boolean | undefined; size?: "sm" | "lg" }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm font-semibold uppercase tracking-wide",
        size === "lg" ? "px-2.5 py-1 text-sm" : "px-1.5 py-0.5 text-[10px]",
        pass === true && "bg-success/15 text-success",
        pass === false && "bg-destructive/15 text-destructive",
        pass === undefined && "bg-muted text-muted-foreground",
      )}
    >
      {pass === true ? "pass" : pass === false ? "fail" : "—"}
    </span>
  );
}

// A — Verdict card: one dense card above the tabs, everything visible.
function VariantCard({ facts }: { facts: JudgmentFacts }) {
  return (
    <div className="shrink-0 border-b border-border bg-muted/15 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <VerdictPill pass={facts.pass} />
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

// B — Dossier: two columns, the task on the left, the ruling on the right.
function VariantDossier({ facts }: { facts: JudgmentFacts }) {
  return (
    <div className="shrink-0 border-b border-border px-3 py-3">
      <div className="grid grid-cols-2 gap-4">
        <div className="min-w-0">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            The task judged
          </div>
          <p className="truncate text-sm font-medium text-foreground">{facts.name}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {facts.instruction ?? "—"}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[10px] text-muted-foreground">
            <span className="rounded-sm border border-border px-1.5 py-0.5">{facts.kind}</span>
            <span className="rounded-sm border border-border px-1.5 py-0.5">{facts.model ?? "?"}</span>
            {facts.toolChildren > 0 && (
              <span className="rounded-sm border border-border px-1.5 py-0.5">
                {facts.toolChildren} tool calls
              </span>
            )}
          </div>
        </div>
        <div className="min-w-0 border-l border-border pl-4">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            The ruling
          </div>
          <VerdictPill pass={facts.pass} size="lg" />
          <p
            className={cn(
              "mt-2 text-xs leading-relaxed",
              facts.pass === false ? "text-destructive" : "text-foreground/90",
            )}
          >
            {facts.reasoning ?? "—"}
          </p>
        </div>
      </div>
    </div>
  );
}

// C — Ruling first: one skimmable line, full text on demand.
function VariantRuling({ facts }: { facts: JudgmentFacts }) {
  const firstSentence = facts.reasoning?.split(/(?<=\.)\s/)[0] ?? "—";
  return (
    <div className="shrink-0 border-b border-border px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <VerdictPill pass={facts.pass} />
        <span className={cn("truncate", facts.pass === false ? "text-destructive" : "text-foreground")}>
          {firstSentence}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{facts.model ?? "?"}</span>
      </div>
      <details className="mt-1 text-muted-foreground">
        <summary className="cursor-pointer select-none text-[10px] uppercase tracking-wide hover:text-foreground">
          judgment details · {facts.name}
        </summary>
        <p className="mt-1.5 leading-relaxed text-foreground/85">{facts.reasoning}</p>
        <p className="mt-1.5 leading-relaxed">{facts.instruction}</p>
        {facts.toolChildren > 0 && (
          <p className="mt-1.5 font-mono text-[10px]">investigated with {facts.toolChildren} tool calls</p>
        )}
      </details>
    </div>
  );
}

const VARIANTS = [
  { key: "current", label: "current · JSON tabs" },
  { key: "a", label: "A · verdict card" },
  { key: "b", label: "B · dossier columns" },
  { key: "c", label: "C · ruling line" },
] as const;
type VariantKey = (typeof VARIANTS)[number]["key"];

function protoVariant(): VariantKey {
  if (typeof window === "undefined") return "current";
  const v = new URLSearchParams(window.location.search).get("detail");
  return VARIANTS.some((x) => x.key === v) ? (v as VariantKey) : "current";
}

export function JudgmentBrief({ call, allCalls }: { call: LoggedCall; allCalls: LoggedCall[] }) {
  const facts = judgmentFacts(call, allCalls);
  const [variant, setVariant] = useState<VariantKey>("current");
  useEffect(() => {
    setVariant(protoVariant());
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const cur = protoVariant();
      const idx = VARIANTS.findIndex((v) => v.key === cur);
      const nextKey = e.key === "ArrowRight"
        ? VARIANTS[(idx + 1) % VARIANTS.length].key
        : VARIANTS[(idx - 1 + VARIANTS.length) % VARIANTS.length].key;
      const url = new URL(window.location.href);
      if (nextKey === "current") url.searchParams.delete("detail");
      else url.searchParams.set("detail", nextKey);
      window.history.replaceState(null, "", url);
      setVariant(nextKey);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!facts) return null;

  const cycle = (dir: 1 | -1) => {
    const idx = VARIANTS.findIndex((v) => v.key === variant);
    const nextKey = VARIANTS[(idx + dir + VARIANTS.length) % VARIANTS.length].key;
    const url = new URL(window.location.href);
    if (nextKey === "current") url.searchParams.delete("detail");
    else url.searchParams.set("detail", nextKey);
    window.history.replaceState(null, "", url);
    setVariant(nextKey);
  };

  return (
    <>
      {variant === "a" && <VariantCard facts={facts} />}
      {variant === "b" && <VariantDossier facts={facts} />}
      {variant === "c" && <VariantRuling facts={facts} />}
      {process.env.NODE_ENV !== "production" && (
        <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-sm border border-border bg-background/95 p-1 text-xs shadow-lg">
          <button
            type="button"
            onClick={() => cycle(-1)}
            aria-label="Previous judgment variant"
            className="rounded-sm px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            ←
          </button>
          <span className="px-1 text-muted-foreground">
            judgment detail · {VARIANTS.find((v) => v.key === variant)?.label}
          </span>
          <button
            type="button"
            onClick={() => cycle(1)}
            aria-label="Next judgment variant"
            className="rounded-sm px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            →
          </button>
        </div>
      )}
    </>
  );
}
