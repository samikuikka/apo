"use client";

import type { ReactNode } from "react";

import { callCacheTokens, wholeCallTokens, wholePromptTokens, type CallCacheTokens } from "@/lib/cumulative-metrics";
import { formatCostMicro, formatInputCacheSplit, formatTokenBreakdown, formatTokenTotal } from "@/lib/format";
import { CopyIdPopover } from "./CopyIdPopover";
import { CallCostBreakdownTooltip } from "./DimensionBreakdownTooltip";
import { MetadataRow } from "./MetadataRow";
import { getEventType } from "./trace-utils";
import { getDisplayName } from "./trace-display";
import { formatDate, formatEventLabel } from "./call-detail-utils";
import type { LoggedCall, TraceDetail } from "./contexts/TraceDataContext";

interface CallMetadataTabProps {
  call: LoggedCall;
  run: TraceDetail | null;
}

export function CallMetadataTab({ call, run }: CallMetadataTabProps) {
  const eventType = getEventType(call);
  const cache = callCacheTokens(call);

  return (
    <div className="space-y-1.5">
      <MetadataRow label="Observation ID" value={<CopyIdPopover ids={[{ label: "Observation ID", value: call.id }, { label: "Trace ID", value: run?.run?.id ?? "" }]}><span className="font-mono cursor-pointer">{call.id}</span></CopyIdPopover>} />
      <MetadataRow label="Step" value={getDisplayName(call)} />
      <MetadataRow label="Type" value={call.call_type || "—"} />
      <MetadataRow label="Event" value={eventType ? formatEventLabel(eventType) : "—"} />
      <MetadataRow label="Model" value={call.model && call.model !== "unknown" ? call.model : "—"} />
      <MetadataRow label="Tool" value={call.tool_name || "—"} />
      <MetadataRow label="Started" value={formatDate(call.created_at)} />
      <MetadataRow label="Latency" value={call.latency_ms != null ? `${call.latency_ms.toFixed(0)}ms` : "—"} />
      <MetadataRow label="TTFT" value={call.time_to_first_token_ms != null ? `${call.time_to_first_token_ms.toFixed(0)}ms` : "—"} />
      <MetadataRow label="Tokens" value={tokensValue(call, cache)} />
      <MetadataRow label="Cost" value={call.cost != null ? <CallCostBreakdownTooltip breakdown={call.cost_breakdown} rawUsage={call.raw_usage} modelName={call.model} provenance={call.cost_provenance} cost={call.cost}><span className="font-mono">{formatCostMicro(call.cost)}</span></CallCostBreakdownTooltip> : "\u2014"} />
      {call.end_time ? <MetadataRow label="Ended" value={formatDate(call.end_time)} /> : null}
      {call.status_message ? <MetadataRow label="Status" value={<span className={call.level === "ERROR" ? "text-destructive font-medium" : ""}>{call.status_message}</span>} /> : null}
      {call.environment && call.environment !== "default" ? <MetadataRow label="Environment" value={<span className="inline-flex items-center border border-border/70 bg-muted/10 px-1.5 py-0.5 text-xs">{call.environment}</span>} /> : null}
      {call.session_id ? <MetadataRow label="Session" value={<span className="font-mono text-xs">{call.session_id}</span>} /> : null}
      {call.tags?.length ? <MetadataRow label="Tags" value={<div className="flex flex-wrap gap-1 justify-end">{call.tags.map((tag: string) => <span key={tag} className="inline-flex items-center border border-border/70 bg-muted/10 px-1.5 py-0.5 text-xs">{tag}</span>)}</div>} /> : null}
      {call.version ? <MetadataRow label="Version" value={<span className="font-mono text-xs">{call.version}</span>} /> : null}
    </div>
  );
}

function tokensValue(call: LoggedCall, cache: CallCacheTokens): ReactNode {
  const total = wholeCallTokens(call);
  if (total <= 0) return "\u2014";
  if (wholePromptTokens(call) == null && call.completion_tokens == null) {
    return formatTokenTotal(call.total_tokens ?? 0, cache.cache_read_tokens);
  }
  const prompt = wholePromptTokens(call) ?? 0;
  return (
    <span
      title={
        cache.input_uncached != null
          ? formatInputCacheSplit(cache.input_uncached, cache.cache_read_tokens, cache.cache_write_tokens)
          : undefined
      }
    >
      {formatTokenBreakdown(prompt, call.completion_tokens ?? 0, cache.cache_read_tokens)}
    </span>
  );
}
