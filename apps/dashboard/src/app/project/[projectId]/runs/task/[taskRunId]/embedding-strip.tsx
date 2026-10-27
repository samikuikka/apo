"use client";

import { Cpu, Timer, Workflow } from "lucide-react";
import Link from "next/link";
import type { EmbeddingMetadata } from "@/lib/agent-task-api";
import { cn } from "@/lib/utils";

function formatLatency(ms?: number): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Embedding-similarity details (t.semantic): what graded under which pinned
 * settings, at what score. The similarity/threshold bar renders the number
 * as a position, not just a decimal — a 0.61 against a 0.70 bar reads at a
 * glance how far off the verdict was.
 */
export function EmbeddingStrip({
  embedding,
  checkPass,
  traceHref,
}: {
  embedding: EmbeddingMetadata;
  checkPass?: boolean;
  /** Deep link into the EMBEDDING observation span; null when untraceable. */
  traceHref?: string | null;
}) {
  const similarity = embedding.similarity;
  const threshold = embedding.threshold;
  // A marginal score (within 0.02 of the threshold) is one model drift away
  // from flipping — the SDK notes it in the reasoning; mirror the flag here.
  const marginal =
    similarity != null && threshold != null && Math.abs(similarity - threshold) < 0.02;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {embedding.model && (
          <span className="inline-flex items-center gap-1.5">
            <Cpu className="h-3 w-3" />
            <span className="font-mono">
              {embedding.model}
              {embedding.dimensions != null && `:${embedding.dimensions}d`}
            </span>
          </span>
        )}
        {embedding.served_model && embedding.served_model !== embedding.model && (
          <span title="The gateway served a different model than requested">
            served <span className="font-mono">{embedding.served_model}</span>
          </span>
        )}
        {similarity != null && threshold != null && (
          <SimilarityBar similarity={similarity} threshold={threshold} pass={checkPass} />
        )}
        {marginal && (
          <span className="border border-border px-1.5 py-0.5 text-[10px]" title="Within 0.02 of the threshold — this verdict will flip on model drift">
            marginal
          </span>
        )}
        {embedding.tokens?.input != null && (
          <span>
            <span className="text-foreground">{embedding.tokens.input}</span> tok in
          </span>
        )}
        {embedding.latency_ms != null && (
          <span className="inline-flex items-center gap-1.5">
            <Timer className="h-3 w-3" />
            <span>{formatLatency(embedding.latency_ms)}</span>
          </span>
        )}
        {traceHref && (
          <Link
            href={traceHref}
            className="ml-auto inline-flex items-center gap-1 border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <Workflow className="h-3 w-3" />
            View in trace
          </Link>
        )}
      </div>

      {embedding.settings_hash && (
        <p className="font-mono text-[10px] text-muted-foreground/80" title="Everything that can move this score — similarity numbers from different signatures are not comparable">
          {embedding.settings_hash}
        </p>
      )}

      {(embedding.value_preview || embedding.reference_preview) && (
        <div className="grid grid-cols-2 gap-2 border border-border bg-background/40 p-2">
          <PreviewColumn label="Value" text={embedding.value_preview} />
          <PreviewColumn label="Reference" text={embedding.reference_preview} />
        </div>
      )}
    </div>
  );
}

/** Score vs threshold as a positioned bar: threshold tick, score fill. */
function SimilarityBar({
  similarity,
  threshold,
  pass,
}: {
  similarity: number;
  threshold: number;
  pass?: boolean;
}) {
  const pct = (v: number) => `${Math.max(0, Math.min(1, v)) * 100}%`;
  return (
    <span className="inline-flex items-center gap-1.5" title={`cosine ${similarity.toFixed(4)} vs threshold ${threshold.toFixed(4)}`}>
      <span className="relative inline-flex h-1.5 w-20 overflow-hidden bg-muted align-middle">
        <span
          className={cn("h-full", pass === false ? "bg-destructive/70" : "bg-success/70")}
          style={{ width: pct(similarity) }}
        />
        <span
          className="absolute inset-y-0 w-px bg-foreground"
          style={{ left: pct(threshold) }}
        />
      </span>
      <span className="font-mono">
        <span className="text-foreground">{similarity.toFixed(4)}</span>
        <span className="text-muted-foreground"> / {threshold.toFixed(4)}</span>
      </span>
    </span>
  );
}

function PreviewColumn({ label, text }: { label: string; text?: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="line-clamp-3 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground">
        {text ?? "—"}
      </p>
    </div>
  );
}
