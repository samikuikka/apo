"use client";

import { useState, useMemo, Fragment } from "react";
import { Star, ChevronRight, AlertCircle, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCostMicro, formatTokenTotal } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { CopyIdPopover } from "./CopyIdPopover";
import { ScoreInputPanel } from "./ScoreInputPanel";
import { CommentDrawer } from "./CommentDrawer";
import { CallCostBreakdownTooltip } from "./DimensionBreakdownTooltip";
import { HeaderPill } from "./HeaderPill";
import { ItemTypeBadge } from "./ItemTypeBadge";
import { getEventType } from "./trace-utils";
import { getDisplayName } from "./trace-display";
import {
  formatDate,
  formatEventLabel,
  formatMetaParts,
  formatParamValue,
  extractModelParams,
  getAncestorPath,
  getModelShort,
  getObservationType,
} from "./call-detail-utils";
import type { CumulativeMetrics } from "@/lib/cumulative-metrics";

interface CallDetailHeaderProps {
  call: any;
  run: any;
  cumulativeMetrics: Map<string, CumulativeMetrics>;
  selectCall: (callId: string | null) => void;
  /** Bumped when an inline comment is created so the drawer re-fetches. */
  commentNonce: number;
}

export function CallDetailHeader({
  call,
  run,
  cumulativeMetrics,
  selectCall,
  commentNonce,
}: CallDetailHeaderProps) {
  const [showScorePanel, setShowScorePanel] = useState(false);
  const eventType = getEventType(call);
  const ancestorPath = useMemo(
    () => getAncestorPath(call, run?.calls ?? []),
    [call, run?.calls],
  );
  const cumulative = cumulativeMetrics.get(call.id);
  const hasDescendants = cumulative && cumulative.descendant_count > 0;
  const modelParams = extractModelParams(call);
  const summaryParts = formatMetaParts([
    call.model && call.model !== "unknown" ? getModelShort(call.model) : null,
    call.latency_ms != null ? `${call.latency_ms.toFixed(0)}ms` : null,
    call.time_to_first_token_ms != null ? `TTFT ${call.time_to_first_token_ms.toFixed(0)}ms` : null,
    call.total_tokens != null && call.total_tokens > 0 ? formatTokenTotal(call.total_tokens) : null,
    call.cost != null ? formatCostMicro(call.cost) : null,
    eventType ? formatEventLabel(eventType) : null,
  ]);
  const cumulativeParts = hasDescendants ? formatMetaParts([
    cumulative.total_tokens > 0 ? `\u03A3 ${formatTokenTotal(cumulative.total_tokens)}` : null,
    cumulative.cost > 0 ? `\u03A3 ${formatCostMicro(cumulative.cost)}` : null,
    `${cumulative.descendant_count} descendant${cumulative.descendant_count === 1 ? "" : "s"}`,
  ]) : [];

  return (
    <div className="shrink-0 space-y-2 border-b p-3">
      <button
        type="button"
          onClick={() => selectCall(null)}
        className="flex h-5 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" />
        <span>Back</span>
      </button>
      {ancestorPath.length > 1 && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
          {ancestorPath.map((node: any, i: number) => (
            <Fragment key={node.id}>
              {i > 0 && <ChevronRight className="h-2.5 w-2.5 shrink-0" />}
              <button
                type="button"
                onClick={() => selectCall(node.id)}
                className={cn(
                  "hover:text-foreground transition-colors truncate max-w-[120px]",
                  node.id === call.id && "text-foreground font-medium",
                )}
              >
                {getDisplayName(node)}
              </button>
            </Fragment>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <ItemTypeBadge type={getObservationType(call)} />
        <span className="min-w-0 truncate text-sm font-medium">
          {getDisplayName(call)}
        </span>
      </div>
      <div className="text-sm text-muted-foreground">
        {formatDate(call.created_at)}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {summaryParts.map((part) => {
          const isCost = part.startsWith("$");
          const pill = (
            <HeaderPill key={part} mono={isCost || part.includes("tok") || part.includes("ms")}>
              {part}
            </HeaderPill>
          );
          if (isCost && call.cost != null) {
            return (
              <CallCostBreakdownTooltip
                key={part}
                breakdown={call.cost_breakdown}
                rawUsage={call.raw_usage}
                modelName={call.model}
                provenance={call.cost_provenance}
                cost={call.cost}
              >
                {pill}
              </CallCostBreakdownTooltip>
            );
          }
          return pill;
        })}
        {cumulativeParts.length > 0 && (
          <>
            <span className="text-muted-foreground/40">|</span>
            {cumulativeParts.map((part) => (
              <HeaderPill key={part} mono={part.includes("$") || part.includes("tok")}>
                {part}
              </HeaderPill>
            ))}
          </>
        )}
        {modelParams && Object.entries(modelParams).map(([key, value]) => (
          <span key={key} className="inline-flex items-center bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            {key}: {formatParamValue(value)}
          </span>
        ))}
        {call.version && <HeaderPill mono>{call.version}</HeaderPill>}
        {call.environment && call.environment !== "default" && <HeaderPill>env: {call.environment}</HeaderPill>}
        {call.session_id && <HeaderPill mono>session: {call.session_id.length > 12 ? `${call.session_id.slice(0, 12)}...` : call.session_id}</HeaderPill>}
        <CopyIdPopover ids={[{ label: "Observation ID", value: call.id }, { label: "Trace ID", value: run?.run?.id ?? "" }]}>
          <HeaderPill mono>{call.id.slice(0, 12)}</HeaderPill>
        </CopyIdPopover>
        <Button
          type="button"
          variant={showScorePanel ? "secondary" : "outline"}
          size="xs"
          onClick={() => setShowScorePanel(!showScorePanel)}
        >
          <Star className="h-3 w-3" />
          Score
        </Button>
        <CommentDrawer
          objectId={call.id}
          objectType="observation"
          projectId={run?.run?.project}
          refreshNonce={commentNonce}
         />
      </div>
      {call.status_message && (call.level === "ERROR" || call.level === "WARNING") && (
        <div className={cn(
          "flex items-center gap-2 border px-2 py-1.5 text-xs",
          call.level === "ERROR"
            ? "border-destructive/30 bg-destructive/5 text-destructive"
            : "border-warning/30 bg-warning/10 text-warning",
        )}>
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="break-words">{call.status_message}</span>
        </div>
      )}
      {showScorePanel && (
        <div className="mt-2 border border-border bg-muted/30">
          <ScoreInputPanel
            targetType="observation"
            targetId={call.id}
            onScoreCreated={() => {}}
          />
        </div>
      )}
    </div>
  );
}
