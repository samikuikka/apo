"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { type ToolDefinition } from "./tool-utils";

interface ToolDefinitionsSectionProps {
  tools: ToolDefinition[];
  invocationCounts?: Record<string, number>;
}

export function ToolDefinitionsSection({ tools, invocationCounts }: ToolDefinitionsSectionProps) {
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [sectionOpen, setSectionOpen] = useState(tools.length <= 3);

  if (tools.length === 0) return null;

  const sortedTools = tools.toSorted((a, b) => {
    const countA = invocationCounts?.[a.function?.name ?? ""] ?? 0;
    const countB = invocationCounts?.[b.function?.name ?? ""] ?? 0;
    return countB - countA;
  });

  const toggleTool = (name: string) => {
    setExpandedTools((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  return (
    <Collapsible open={sectionOpen} onOpenChange={setSectionOpen}>
      <div className="mb-3 rounded-lg border border-border/60 bg-muted/20">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/40 rounded-lg transition-colors"
          >
            {sectionOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <Wrench className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">
              Tool Definitions
            </span>
            <Badge variant="secondary" className="text-xs">
              {tools.length}
            </Badge>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 px-3 pb-3">
            {sortedTools.map((tool, index) => (
              <ToolDefinitionCard
                key={tool.function?.name ?? `tool-${index}`}
                tool={tool}
                invocationCount={invocationCounts?.[tool.function?.name ?? ""] ?? 0}
                expanded={expandedTools[tool.function?.name ?? ""] ?? false}
                onToggle={() => toggleTool(tool.function?.name ?? "")}
              />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function ToolDefinitionCard({
  tool,
  invocationCount,
  expanded,
  onToggle,
}: {
  tool: ToolDefinition;
  invocationCount: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const name = tool.function?.name ?? "unknown";
  const description = tool.function?.description;
  const parameters = tool.function?.parameters;

  return (
    <div className="rounded-md border border-border/60 bg-background/60">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`Toggle ${name} parameters`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-xs font-medium text-foreground">
              {name}
            </span>
            {invocationCount > 0 && (
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {invocationCount}x
              </Badge>
            )}
          </div>
          {description && (
            <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {expanded ? (
          <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {expanded && parameters != null ? (
        <div className="border-t border-border/60 px-3 py-2">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11px] font-mono text-muted-foreground">
            {formatParameters(parameters)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function formatParameters(parameters: unknown): string {
  if (typeof parameters === "string") return parameters;
  return JSON.stringify(parameters, null, 2) ?? "{}";
}
