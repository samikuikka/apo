"use client";

/**
 * lazy-loading Deliverables panel.
 *
 * Receives only the manifest initially — names, kinds, sizes — so opening the
 * Deliverables tab issues no body request. Expanding one JSON row fetches
 * exactly that body through the authenticated same-origin proxy; collapsing
 * aborts the in-flight request. Artifact rows expose an authenticated
 * Download action. Conversation History remains Trace-derived.
 */

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Download, FileText, Loader2 } from "lucide-react";
import { ExpandableJson } from "@/components/ExpandableJson";
import { DeliverableMarkdown } from "@/components/agent-task-execution/deliverable-markdown";
import { looksLikeMarkdown } from "@/lib/looks-like-markdown";
import {
  type DeliverableSummary,
  fetchDeliverableBody,
} from "@/lib/agent-task-deliverables-api";

// shiki is a heavy dependency — loaded only when a code deliverable renders.
const ShikiCodeBlock = dynamic(
  () => import("@/components/shiki-code-block").then((m) => m.ShikiCodeBlock),
  { ssr: false, loading: () => <div className="min-h-12" /> },
);

interface DeliverablesPanelProps {
  items: DeliverableSummary[];
}

export function DeliverablesPanel({ items }: DeliverablesPanelProps) {
  if (items.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-muted-foreground">No deliverables</p>
    );
  }
  return (
    <div className="divide-y divide-border overflow-hidden border border-border">
      {items.map((item) => (
        <DeliverableRow key={item.id} item={item} />
      ))}
    </div>
  );
}

function DeliverableRow({ item }: { item: DeliverableSummary }) {
  const isArtifact = item.kind === "artifact";
  if (isArtifact) {
    return <ArtifactRow item={item} />;
  }
  return <JsonRow item={item} />;
}

function JsonRow({ item }: { item: DeliverableSummary }) {
  const [expanded, setExpanded] = useState(false);
  // Bodies and errors are keyed by download URL, and loading is derived from
  // their absence — so expanding never renders a frame with another URL's
  // state, and no effect has to reset state on prop change.
  const [loadedBodies, setLoadedBodies] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const url = item.download_url;

  useEffect(() => {
    // Only fetch when expanded, and only once per URL. Collapsing aborts any
    // in-flight request so no stale state update lands.
    if (!expanded || url === null || url in loadedBodies) return;
    const controller = new AbortController();
    fetchDeliverableBody(url, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setLoadedBodies((prev) => ({ ...prev, [url]: value }));
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (controller.signal.aborted) return;
        setErrors((prev) => ({
          ...prev,
          [url]: err instanceof Error ? err.message : "Failed to load",
        }));
      });
    return () => {
      controller.abort();
    };
  }, [expanded, url, loadedBodies]);

  const hasBody = url !== null && url in loadedBodies;
  const body = hasBody && url !== null ? loadedBodies[url] : null;
  const error =
    !hasBody && url !== null && url in errors ? errors[url] : null;
  const isLoading = expanded && url !== null && !hasBody && error === null;

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Toggle deliverable ${item.name}`}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/20"
      >
        <span className="text-muted-foreground/60">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-sm text-foreground">{item.name}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/50">
          {item.size_bytes.toLocaleString()} bytes
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border/50 bg-background/50">
          {isLoading && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          )}
          {error !== null && (
            <p className="px-3 py-2 text-xs text-destructive">{error}</p>
          )}
          {!isLoading && error === null && body !== null && (
            <BodyValue value={body} />
          )}        </div>
      )}
    </div>
  );
}

function BodyValue({ value }: { value: unknown }) {
  const isObject = typeof value === "object" && value !== null;
  const isString = typeof value === "string";
  if (isObject) {
    return <ExpandableJson data={value} className="!rounded-none !border-0 !shadow-none" />;
  }
  if (isString && looksLikeMarkdown(value)) {
    return <DeliverableMarkdown text={value} />;
  }
  const code = isString ? value : String(value ?? "");
  return <ShikiCodeBlock code={code} language="text" className="!rounded-none !border-0" />;
}

function ArtifactRow({ item }: { item: DeliverableSummary }) {
  const filename = item.display_filename ?? item.name;
  const href = item.download_url ?? "#";
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate font-mono text-sm text-foreground">{item.name}</span>
      <span className="text-[10px] text-muted-foreground/50">{item.media_type}</span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        <span className="font-mono text-[10px] text-muted-foreground/50">
          {item.size_bytes.toLocaleString()} bytes
        </span>
        <a
          href={href}
          download={filename}
          aria-label={`Download ${item.name}`}
          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted/40"
        >
          <Download className="h-3 w-3" /> Download
        </a>
      </span>
    </div>
  );
}
