"use client";

import { useState } from "react";
import { ScrollText } from "lucide-react";
import { ToolDefinitionsSection } from "./ToolDefinitionsSection";
import { extractCallContext } from "./tool-utils";
import type { LoggedCall } from "./contexts/TraceDataContext";

const COLLAPSED_LINES = 20;
const COLLAPSED_CHARS = 2000;

/**
 * The model-facing context a call carried: its system instructions and the
 * tools offered to the model. Producers emit these only on the calls where
 * they change (typically a session's first generation), so most calls have
 * none and the tab is not offered for them.
 */
export function CallContextTab({ call }: { call: LoggedCall }) {
  const { tools, systemInstructions } = extractCallContext(call.metadata);
  if (!systemInstructions && tools.length === 0) return null;

  return (
    <div className="space-y-3">
      {systemInstructions ? <SystemInstructions text={systemInstructions} /> : null}
      <ToolDefinitionsSection tools={tools} defaultOpen />
    </div>
  );
}

function collapsedPreview(text: string): string | null {
  const lines = text.split("\n");
  if (lines.length <= COLLAPSED_LINES && text.length <= COLLAPSED_CHARS) return null;
  return lines.slice(0, COLLAPSED_LINES).join("\n").slice(0, COLLAPSED_CHARS);
}

function SystemInstructions({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = collapsedPreview(text);
  const lineCount = text.split("\n").length;

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <ScrollText className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">System instructions</span>
      </div>
      <div className="px-3 pb-3">
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/60 px-3 py-2 font-mono text-[11px] text-foreground">
          {preview !== null && !expanded ? `${preview}…` : text}
        </pre>
        {preview !== null ? (
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            className="mt-2 text-xs text-muted-foreground underline hover:text-foreground"
          >
            {expanded ? "Show less" : `Show all (${lineCount} lines)`}
          </button>
        ) : null}
      </div>
    </div>
  );
}
