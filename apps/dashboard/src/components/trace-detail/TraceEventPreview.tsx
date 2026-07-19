"use client";

import type { ReactNode } from "react";
import { Brain, CheckCircle2, MessageSquare, Timer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ExpandableJson } from "@/components/ExpandableJson";
import { ToolCallPreview } from "./ToolCallPreview";
import { Markdown } from "./Markdown";
import { formatDuration, usdFormat } from "@/lib/format";
import { detectTraceEventKind } from "./trace-event-utils";

interface TraceEventPreviewProps {
  data: any;
}

type ResultData = {
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  usage?: unknown;
  stop_reason?: unknown;
  is_error?: boolean;
};

export function TraceEventPreview({ data }: TraceEventPreviewProps) {
  const kind = detectTraceEventKind(data);

  if (kind === "tool_call") {
    return <ToolCallPreview data={data} />;
  }

  if (kind === "tool_result") {
    return <ToolResultPreview data={data} />;
  }

  if (kind === "assistant_reasoning") {
    return <ReasoningPreview data={data} />;
  }

  if (kind === "assistant_message") {
    return <AssistantMessagePreview data={data} />;
  }

  if (kind === "result") {
    return <ResultPreview data={data} />;
  }

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-4">
      <pre className="whitespace-pre-wrap break-words text-xs font-mono text-foreground">
        {formatPlainText(data)}
      </pre>
    </div>
  );
}

function ReasoningPreview({ data }: TraceEventPreviewProps) {
  const text = extractNestedText(data);

  return (
    <PreviewPanel icon={<Brain className="h-3.5 w-3.5 text-muted-foreground" />} title="Reasoning" badge="Agent">
      <div className="rounded-md border border-border/60 bg-background/60 p-3">
        <Markdown>{text || "No reasoning text captured."}</Markdown>
      </div>
    </PreviewPanel>
  );
}

function AssistantMessagePreview({ data }: TraceEventPreviewProps) {
  const text = extractNestedText(data);
  const jsonPayload = parseJsonLikeText(text);

  return (
    <PreviewPanel
      icon={<MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />}
      title="Assistant Message"
      badge="Agent"
      extraBadge={jsonPayload ? "JSON" : undefined}
    >
      {jsonPayload ? (
        <ExpandableJson data={jsonPayload} />
      ) : (
        <div className="rounded-md border border-border/60 bg-background/60 p-3">
          <Markdown>{text || "No assistant text captured."}</Markdown>
        </div>
      )}
    </PreviewPanel>
  );
}

function ResultPreview({ data }: TraceEventPreviewProps) {
  const result = extractResultData(data);

  return (
    <PreviewPanel
      icon={<CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />}
      title="Run Result"
      badge={result.is_error ? "Error" : "Completed"}
      badgeVariant={result.is_error ? "destructive" : "secondary"}
    >
      <div className="space-y-3">
        <div className="grid gap-2 md:grid-cols-3">
          <MetricPill
            icon={<Timer className="h-3.5 w-3.5" />}
            label="Duration"
            value={formatDuration(result.duration_ms)}
          />
          <MetricPill
            icon={<Timer className="h-3.5 w-3.5" />}
            label="API Duration"
            value={formatDuration(result.duration_api_ms)}
          />
          <MetricPill
            label="Cost"
            value={usdFormat(result.total_cost_usd ?? null)}
          />
        </div>

        {Boolean(result.stop_reason || result.usage) && (
          <div className="space-y-3">
            {result.stop_reason ? (
              <div className="space-y-1">
                <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                  Stop Reason
                </p>
                <Badge variant="outline">{String(result.stop_reason)}</Badge>
              </div>
            ) : null}

            {result.usage ? (
              <div className="space-y-1">
                <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                  Usage
                </p>
                <ExpandableJson data={result.usage} />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </PreviewPanel>
  );
}

function ToolResultPreview({ data }: TraceEventPreviewProps) {
  const payload = extractToolResultData(data);

  return (
    <PreviewPanel
      icon={<CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />}
      title="Tool Result"
      badge={payload?.is_error ? "Error" : "Success"}
      badgeVariant={payload?.is_error ? "destructive" : "secondary"}
      extraBadge={payload?.tool_use_id}
      extraBadgeMono
    >
      <div>
        {typeof payload?.content === "string" ? (
          <div className="rounded-md border border-border/60 bg-background/60 p-3">
            <pre className="whitespace-pre-wrap break-words text-xs font-mono text-foreground">
              {payload.content}
            </pre>
          </div>
        ) : (
          <ExpandableJson data={payload?.content ?? {}} />
        )}
      </div>
    </PreviewPanel>
  );
}

function PreviewPanel({
  icon,
  title,
  badge,
  badgeVariant = "secondary",
  extraBadge,
  extraBadgeMono = false,
  children,
}: {
  icon?: ReactNode;
  title: string;
  badge?: string;
  badgeVariant?: "secondary" | "destructive" | "outline";
  extraBadge?: string;
  extraBadgeMono?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/10 p-3">
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <span className="text-sm font-medium text-foreground">{title}</span>
        {badge ? <Badge variant={badgeVariant}>{badge}</Badge> : null}
        {extraBadge ? (
          <Badge variant="outline" className={extraBadgeMono ? "font-mono text-[10px]" : undefined}>
            {extraBadge}
          </Badge>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function MetricPill({
  icon,
  label,
  value,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/60 p-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-1 text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

function extractNestedText(data: any): string {
  if (typeof data?.text === "string") {
    return data.text;
  }

  if (typeof data?.data?.text === "string") {
    return data.data.text;
  }

  if (typeof data === "string") {
    return data;
  }

  return "";
}

function extractResultData(data: any): ResultData {
  if (data?.data && typeof data.data === "object") {
    return data.data;
  }

  if (typeof data === "object" && data !== null) {
    return data;
  }

  return {};
}

function extractToolResultData(data: any) {
  if (data?.data && typeof data.data === "object") {
    return data.data;
  }

  if (typeof data === "object" && data !== null) {
    return data;
  }

  return null;
}

function parseJsonLikeText(text: string): unknown | null {
  if (!text) {
    return null;
  }

  const direct = tryParseJson(text);
  if (direct !== null) {
    return direct;
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (!fenced?.[1]) {
    return null;
  }

  return tryParseJson(fenced[1]);
}

function tryParseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function formatPlainText(data: any): string {
  if (data === null || data === undefined) {
    return "-";
  }

  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return data;
    }
  }

  if (typeof data === "object") {
    return JSON.stringify(data, null, 2);
  }

  return String(data);
}
