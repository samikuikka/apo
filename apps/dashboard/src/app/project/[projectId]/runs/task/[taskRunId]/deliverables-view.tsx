"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";
import { ExpandableJson } from "@/components/ExpandableJson";
import { ShikiCodeBlock } from "@/components/shiki-code-block";
import { DeliverableMarkdown } from "@/components/agent-task-execution/deliverable-markdown";
import { looksLikeMarkdown, parseJsonText } from "@/lib/looks-like-markdown";

export function DeliverablesView({ deliverables }: { deliverables: Record<string, unknown> }) {
  const entries = Object.entries(deliverables);
  if (entries.length === 0) {
    return <p className="py-4 text-center text-sm text-muted-foreground">No deliverables</p>;
  }
  return (
    <div className="divide-y divide-border overflow-hidden border border-border">
      {entries.map(([key, value]) => (
        <DeliverableFile key={key} name={key} value={value} />
      ))}
    </div>
  );
}

function DeliverableFile({ name, value }: { name: string; value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const isString = typeof value === "string";
  // A serialized-JSON body (e.g. a conversation transcript) renders in the
  // tree viewer like any object deliverable.
  const parsedJson = isString ? parseJsonText(value) : null;
  const viewValue: unknown = parsedJson ?? value;
  const isObject = typeof viewValue === "object" && viewValue !== null;
  const code = isObject
    ? JSON.stringify(viewValue, null, 2)
    : isString
      ? value
      : String(value ?? "");
  const lines = code.split("\n").length;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/20"
      >
        <span className="text-muted-foreground/60">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-sm text-foreground">{name}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/50">
          {isObject ? `${Object.keys(viewValue).length} keys` : `${lines} line${lines !== 1 ? "s" : ""}`}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border/50 bg-background/50">
          {isObject ? (
            <ExpandableJson data={viewValue} className="!rounded-none !border-0 !shadow-none" />
          ) : isString && looksLikeMarkdown(value) ? (
            <DeliverableMarkdown text={value} />
          ) : (
            <ShikiCodeBlock code={code} language="text" className="!rounded-none !border-0" />
          )}
        </div>
      )}
    </div>
  );
}
