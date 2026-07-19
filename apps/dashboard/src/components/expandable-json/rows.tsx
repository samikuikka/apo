"use client";

import { useState, useCallback } from "react";
import { Copy, Check, ChevronRight, ChevronDown, Scissors, WrapText } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type JsonNode,
  type StringMode,
  TYPE_COLORS,
  TRUNCATE_AT,
  formatPreview,
  highlightText,
} from "./utils";

function ValueDisplay({
  node,
  collapsed,
  searchQuery,
  stringMode,
  isCurrentMatch,
}: {
  node: JsonNode;
  collapsed: boolean;
  searchQuery: string;
  stringMode: StringMode;
  isCurrentMatch: boolean;
}) {
  if (node.type === "object" || node.type === "array") {
    if (collapsed) {
      return (
        <span className="text-muted-foreground/50 text-xs ml-1">
          {formatPreview(node)}
        </span>
      );
    }
    return null;
  }

  if (node.type === "string") {
    const str = String(node.value);
    const truncated = stringMode === "truncate" && str.length > TRUNCATE_AT;
    const display = truncated ? str.slice(0, TRUNCATE_AT) + "…" : str;
    const wrapCls = stringMode === "nowrap" ? "whitespace-nowrap" : "break-all";
    return (
      <span className={cn(wrapCls, TYPE_COLORS.string)}>
        &quot;{highlightText(display, searchQuery, isCurrentMatch)}&quot;
        {truncated && (
          <span className="text-muted-foreground/40 text-[10px] ml-1">
            ({str.length} chars)
          </span>
        )}
      </span>
    );
  }

  if (node.type === "null") {
    return <span className={TYPE_COLORS.null}>null</span>;
  }

  return (
    <span className={TYPE_COLORS[node.type]}>
      {highlightText(String(node.value), searchQuery, isCurrentMatch)}
    </span>
  );
}

function CopyValue({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);

  return (
    <button
      type="button"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        e.stopPropagation();
        handleCopy();
      }}
      className="shrink-0 opacity-0 group-hover/row:opacity-100 inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground/50 hover:text-foreground transition-opacity"
      aria-label="Copy value"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

export function CopyAllButton({ data }: { data: unknown }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [data]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="rounded-sm border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
      aria-label="Copy all as JSON"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      <span>{copied ? "Copied" : "Copy all"}</span>
    </button>
  );
}

export function StringModeButton({
  mode,
  onCycle,
}: {
  mode: StringMode;
  onCycle: () => void;
}) {
  const icon =
    mode === "truncate" ? (
      <Scissors className="h-3 w-3" />
    ) : (
      <WrapText className={cn("h-3 w-3", mode === "nowrap" && "opacity-50")} />
    );
  const label = mode === "truncate" ? "Trunc" : mode === "wrap" ? "Wrap" : "No-wrap";

  return (
    <button
      type="button"
      onClick={onCycle}
      className="rounded-sm border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
      aria-label={`String mode: ${label}`}
    >
      {icon}
      {label}
    </button>
  );
}

export interface JsonRowDisplayOptions {
  isCurrentMatch: boolean;
  showLineNumbers: boolean;
  stringMode: StringMode;
}

export function JsonRow({
  node,
  isLast: _isLast,
  isCollapsed,
  searchQuery,
  lineNumber,
  display,
  onToggle,
}: {
  node: JsonNode;
  isLast: boolean;
  isCollapsed: boolean;
  searchQuery: string;
  lineNumber: number;
  display: JsonRowDisplayOptions;
  onToggle: () => void;
}) {
  const { isCurrentMatch, showLineNumbers, stringMode } = display;
  const isContainer = node.type === "object" || node.type === "array";
  const showKey = node.key !== null;
  // JSON path for inline-comment anchoring, e.g. "root.choices[0].text" ->
  // "$.choices[0].text". Only leaf rows carry data-json-key-value so that
  // selection offsets are computed against a single value's text.
  const jsonPath = "$" + node.id.substring(4);

  return (
    <div
      className={cn(
        "group/row flex items-start gap-1 px-2 py-px hover:bg-muted/20 transition-colors",
        isCurrentMatch && "bg-amber-400/10",
      )}
      style={{ paddingLeft: `${node.depth * 16 + 8}px` }}
    >
      {showLineNumbers && (
        <span
          className="shrink-0 w-8 text-right text-[10px] text-muted-foreground/30 select-none leading-5 tabular-nums"
          aria-hidden="true"
        >
          {lineNumber}
        </span>
      )}
      <button
        type="button"
        aria-label="Toggle row"
        onClick={onToggle}
        className={cn(
          "shrink-0 mt-0.5 flex h-5 w-5 items-center justify-center rounded-sm transition-colors",
          isContainer
            ? "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            : "invisible",
        )}
      >
        {isContainer ? (
          isCollapsed ? (
            <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )
        ) : (
          <span className="h-3.5 w-3.5" />
        )}
      </button>

      <div
        className={cn(
          "flex min-w-0 flex-1 items-start gap-1 text-xs font-mono leading-5",
          stringMode === "nowrap" && "overflow-x-auto",
        )}
      >
        {showKey && (
          <>
            <span className="shrink-0 text-sky-600 dark:text-sky-400">
              {typeof node.key === "number"
                ? highlightText(`[${node.key}]`, searchQuery, isCurrentMatch)
                : highlightText(String(node.key), searchQuery, isCurrentMatch)}
            </span>
            <span className="shrink-0 text-muted-foreground">:</span>
          </>
        )}

        <span
          data-json-path={jsonPath}
          data-json-key-value={isContainer ? undefined : jsonPath}
          className={cn(
            "min-w-0",
            stringMode === "nowrap" ? "whitespace-nowrap" : "break-all",
          )}
        >
          <ValueDisplay
            node={node}
            collapsed={isCollapsed}
            searchQuery={searchQuery}
            stringMode={stringMode}
            isCurrentMatch={isCurrentMatch}
          />
        </span>
      </div>

      {isContainer && isCollapsed && (
        <CopyValue value={node.type === "object" ? {} : []} />
      )}
      {!isContainer && <CopyValue value={node.value} />}
    </div>
  );
}
