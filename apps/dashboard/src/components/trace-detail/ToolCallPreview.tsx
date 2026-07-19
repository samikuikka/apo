"use client";

import { Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ExpandableJson } from "@/components/ExpandableJson";

interface ToolCallPreviewProps {
  data: any;
}

type ToolCallData = {
  tool_name?: string;
  tool_id?: string;
  input?: unknown;
};

type SkillToolInput = {
  skill?: string;
  args?: unknown;
};

export function ToolCallPreview({ data }: ToolCallPreviewProps) {
  const toolCall = extractToolCallData(data);

  if (!toolCall?.tool_name) {
    return null;
  }

  return (
    <Card className="border-border/60 bg-muted/20">
      <CardHeader className="gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm">{toolCall.tool_name}</CardTitle>
            <Badge variant="secondary">Tool Call</Badge>
          </div>
          {toolCall.tool_id ? (
            <Badge variant="outline" className="font-mono text-[10px]">
              {toolCall.tool_id}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isSkillToolInput(toolCall.input) && toolCall.input.skill ? (
          <div className="space-y-1">
            <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
              Skill
            </p>
            <Badge variant="outline">{toolCall.input.skill}</Badge>
          </div>
        ) : null}

        <div className="space-y-1">
          <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
            {isSkillToolInput(toolCall.input) ? "Skill Input" : "Arguments"}
          </p>
          <ToolInputDisplay input={toolCall.input} />
        </div>
      </CardContent>
    </Card>
  );
}

function ToolInputDisplay({ input }: { input: unknown }) {
  if (isSkillToolInput(input)) {
    if (typeof input.args === "string") {
      return (
        <div className="rounded-lg border border-border/60 bg-background/60 p-3">
          <pre className="whitespace-pre-wrap break-words text-xs font-mono text-foreground">
            {input.args}
          </pre>
        </div>
      );
    }

    return <ExpandableJson data={input.args ?? {}} />;
  }

  if (typeof input === "string") {
    return (
      <div className="rounded-lg border border-border/60 bg-background/60 p-3">
        <pre className="whitespace-pre-wrap break-words text-xs font-mono text-foreground">
          {input}
        </pre>
      </div>
    );
  }

  return <ExpandableJson data={input ?? {}} />;
}

function extractToolCallData(data: any): ToolCallData | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  if (isToolCallData(data)) {
    return data;
  }

  if (data.data && isToolCallData(data.data)) {
    return data.data;
  }

  return null;
}

function isToolCallData(value: any): value is ToolCallData {
  return (
    value &&
    typeof value === "object" &&
    typeof value.tool_name === "string"
  );
}

function isSkillToolInput(value: unknown): value is SkillToolInput {
  return !!(
    value &&
    typeof value === "object" &&
    "skill" in value
  );
}
