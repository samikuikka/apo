"use client";

import { useState, useCallback, useMemo, Fragment } from "react";
import Link from "next/link";
import { useTraceData } from "./contexts/TraceDataContext";
import { useSelection } from "./contexts/SelectionContext";
import { CallDetailTabs } from "./CallDetailTabs";
import { TraceDetailTabs } from "./TraceDetailTabs";
import { CopyIdPopover } from "./CopyIdPopover";
import { ScoreInputPanel } from "./ScoreInputPanel";
import { CallCostBreakdownTooltip, RunCostBreakdownTooltip } from "./DimensionBreakdownTooltip";
import { DiffView } from "./DiffView";
import { CorrectionDialog } from "./CorrectionDialog";
import { saveCorrection } from "@/lib/traces-api";
import { formatCostMicro } from "@/lib/format";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { toggleBookmark } from "@/lib/traces-api";
import { useProjectId } from "@/lib/project-router";
import { taskDetailHref } from "@/lib/task-routes";
import { ArrowLeft, Star, Pencil, ChevronRight, AlertCircle, X, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDuration, formatTokenBreakdown, formatTokenTotal } from "@/lib/format";
import { getEventType } from "./trace-utils";
import { getDisplayName } from "./trace-display";
import { CommentDrawer } from "./CommentDrawer";

const VALID_CALL_TABS = new Set(["preview", "metadata"]);

export function TraceDetailView({
  mode,
  onClose,
  readOnly = false,
}: {
  mode?: "page" | "panel";
  onClose?: () => void;
  readOnly?: boolean;
}) {
  const { run } = useTraceData();
  const { selectedCallId } = useSelection();

  if (!run) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-muted-foreground">No data available</p>
      </div>
    );
  }

  if (selectedCallId) {
    const call = run.calls.find((c) => c.id === selectedCallId);
    if (!call) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <p className="text-muted-foreground">Call not found</p>
        </div>
      );
    }
    return <CallDetailView call={call} readOnly={readOnly} />;
  }

  return <TraceDetailRootView run={run} mode={mode} onClose={onClose} readOnly={readOnly} />;
}

function TraceDetailRootView({
  run,
  mode,
  onClose,
  readOnly = false,
}: {
  run: any;
  mode?: "page" | "panel";
  onClose?: () => void;
  readOnly?: boolean;
}) {
  const projectId = useProjectId();
  const { refreshRun } = useTraceData();
  const [showScorePanel, setShowScorePanel] = useState(false);
  const [bookmarked, setBookmarked] = useState<boolean>(run.run.bookmarked ?? false);
  const totalCost = run.calls.reduce((sum: number, c: any) => sum + (c.cost || 0), 0);
  const totalTokens = run.calls.reduce((sum: number, c: any) => sum + (c.total_tokens || 0), 0);
  const summaryParts = formatMetaParts([
    run.run.duration_ms != null ? formatDuration(run.run.duration_ms) : null,
    totalCost > 0 ? formatCostMicro(totalCost) : null,
    totalTokens > 0 ? formatTokenTotal(totalTokens) : null,
    `${run.run.call_count} calls`,
    run.run.project ? `project ${run.run.project}` : null,
  ]);

  const handleToggleBookmark = useCallback(async () => {
    try {
      const result = await toggleBookmark(run.run.id);
      setBookmarked(result.bookmarked);
    } catch (err) {
      console.error("Failed to toggle bookmark:", err);
    }
  }, [run.run.id]);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="shrink-0 space-y-2 border-b p-3">
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium">
            {run.run.scopeKey || run.run.task_id || "Untitled trace"}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {mode === "panel" && (
              <Link
                href={`/project/${projectId}/traces/${run.run.id}`}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
                aria-label="Open trace in full page"
                title="Open in full page"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            )}
            {mode === "panel" && onClose && (
              <button
                type="button"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
                onClick={onClose}
                aria-label="Close trace panel"
              >
                <X className="h-4 w-4" />
              </button>
            )}
            {!readOnly && (
              <button
                type="button"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center transition-colors hover:bg-muted/50"
                onClick={handleToggleBookmark}
                aria-label={bookmarked ? "Remove bookmark" : "Add bookmark"}
              >
                <Star
                  className={cn(
                    "h-4 w-4 transition-colors",
                    bookmarked ? "fill-warning text-warning" : "text-muted-foreground hover:text-foreground",
                  )}
                />
              </button>
            )}
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          {formatDate(run.run.created_at)}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {summaryParts.map((part) => {
            const isCost = part.startsWith("$");
            const pill = (
              <HeaderPill key={part} mono={isCost || part.includes("tok")}>
                {part}
              </HeaderPill>
            );
            if (isCost && totalCost > 0) {
              return (
                <RunCostBreakdownTooltip key={part} calls={run.calls}>
                  {pill}
                </RunCostBreakdownTooltip>
              );
            }
            return pill;
          })}
          {run.run.task_id && (
            <Link
              href={taskDetailHref(run.run.project, run.run.task_id)}
              className="inline-flex items-center border border-border/70 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {run.run.task_id}
            </Link>
          )}
          {run.run.version && <HeaderPill mono>{run.run.version}</HeaderPill>}
          {run.run.environment && run.run.environment !== "default" && <HeaderPill>env: {run.run.environment}</HeaderPill>}
          {run.run.session_id && <HeaderPill mono>session: {run.run.session_id.length > 12 ? `${run.run.session_id.slice(0, 12)}...` : run.run.session_id}</HeaderPill>}
          {!readOnly && (
            <Button
              type="button"
              variant={showScorePanel ? "secondary" : "outline"}
              size="xs"
              onClick={() => setShowScorePanel(!showScorePanel)}
            >
              <Star className="h-3 w-3" />
              Score
            </Button>
          )}
          {!readOnly && (
            <CommentDrawer
              objectId={run.run.id}
              objectType="trace"
              projectId={run.run.project}
             />
          )}
        </div>
        {showScorePanel && !readOnly && (
          <div className="mt-2 border border-border bg-muted/30">
            <ScoreInputPanel
              targetType="trace"
              targetId={run.run.id}
              onScoreCreated={refreshRun}
            />
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <TraceDetailTabs run={run} />
      </div>
    </div>
  );
}

function CallDetailView({ call, readOnly = false }: { call: any; readOnly?: boolean }) {
  const { selectCall, detailTab, setDetailTab } = useSelection();
  const { cumulativeMetrics, run } = useTraceData();
  // Bumped when an inline comment is created so the drawer re-fetches.
  const [commentNonce, setCommentNonce] = useState(0);
  const refreshCommentCounts = useCallback(
    () => setCommentNonce((n) => n + 1),
    [],
  );
  const eventType = getEventType(call);
  const ancestorPath = useMemo(
    () => getAncestorPath(call, run?.calls ?? []),
    [call, run?.calls],
  );
  const cumulative = cumulativeMetrics.get(call.id);
  const hasDescendants = cumulative && cumulative.descendant_count > 0;
  const section = VALID_CALL_TABS.has(detailTab)
    ? (detailTab as "preview" | "metadata")
    : "preview";
  const [previewMode, setPreviewMode] = useState<"preview" | "json">("preview");
  const [showCorrectionDialog, setShowCorrectionDialog] = useState(false);
  const [correctedOutput, setCorrectedOutput] = useState<string | null>(
    call.corrected_output ?? null,
  );
  const hasToolParams = Boolean(call.tool_parameters && Object.keys(call.tool_parameters).length > 0);
  const hasToolResult = Boolean(call.tool_result && Object.keys(call.tool_result).length > 0);
  // Present a single input->output model regardless of observation kind.
  // Tool observations store their payload in tool_parameters/tool_result and
  // leave input/output empty; unify them so the detail panel always shows the
  // real data under Input and Output (no separate, redundant tool boxes).
  const isTool = (call.observation_type ?? "").toUpperCase() === "TOOL"
    || Boolean(call.tool_name)
    || hasToolParams
    || hasToolResult;
  const effectiveInput = isTool && hasToolParams ? call.tool_parameters : call.input;
  const effectiveOutput = isTool && hasToolResult ? call.tool_result : call.output;
  const [showScorePanel, setShowScorePanel] = useState(false);
  const modelParams = extractModelParams(call);
  const summaryParts = formatMetaParts([
    call.model && call.model !== "unknown" ? getModelShort(call.model) : null,
    call.latency_ms != null ? `${call.latency_ms.toFixed(0)}ms` : null,
    call.time_to_first_token_ms != null ? `TTFT ${call.time_to_first_token_ms.toFixed(0)}ms` : null,
    call.total_tokens != null && call.total_tokens > 0 ? formatTokenTotal(call.total_tokens) : null,
    call.cost != null ? formatCostMicro(call.cost) : null,
    eventType ? formatEventLabel(eventType) : null,
  ]);

  const outputText = extractOutputText(effectiveOutput);
  const canCorrect = outputText !== null;
  const runId = run?.run?.id ?? "";

  const handleSaveCorrection = useCallback(async (text: string | null) => {
    try {
      const result = await saveCorrection(runId, call.id, text);
      setCorrectedOutput(result.corrected_output);
      call.corrected_output = result.corrected_output;
      setShowCorrectionDialog(false);
    } catch (err) {
      console.error("Failed to save correction:", err);
    }
  }, [runId, call]);

  const cumulativeParts = hasDescendants ? formatMetaParts([
    cumulative.total_tokens > 0 ? `\u03A3 ${formatTokenTotal(cumulative.total_tokens)}` : null,
    cumulative.cost > 0 ? `\u03A3 ${formatCostMicro(cumulative.cost)}` : null,
    `${cumulative.descendant_count} descendant${cumulative.descendant_count === 1 ? "" : "s"}`,
  ]) : [];

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
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
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground flex-wrap">
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
            <span key={key} className="inline-flex items-center bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {key}: {formatParamValue(value)}
            </span>
          ))}
          {call.version && <HeaderPill mono>{call.version}</HeaderPill>}
          {call.environment && call.environment !== "default" && <HeaderPill>env: {call.environment}</HeaderPill>}
          {call.session_id && <HeaderPill mono>session: {call.session_id.length > 12 ? `${call.session_id.slice(0, 12)}...` : call.session_id}</HeaderPill>}
          <CopyIdPopover ids={[{ label: "Observation ID", value: call.id }, { label: "Trace ID", value: run?.run?.id ?? "" }]}>
            <HeaderPill mono>{call.id.slice(0, 12)}</HeaderPill>
          </CopyIdPopover>
          {!readOnly && (
          <Button
            type="button"
            variant={showScorePanel ? "secondary" : "outline"}
            size="xs"
            onClick={() => setShowScorePanel(!showScorePanel)}
          >
            <Star className="h-3 w-3" />
            Score
          </Button>
          )}
          {!readOnly && (
          <CommentDrawer
            objectId={call.id}
            objectType="observation"
            projectId={run?.run?.project}
            refreshNonce={commentNonce}
           />
          )}
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
        {showScorePanel && !readOnly && (
          <div className="mt-2 border border-border bg-muted/30">
            <ScoreInputPanel
              targetType="observation"
              targetId={call.id}
              onScoreCreated={() => {}}
            />
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Tabs value={section} onValueChange={(v) => setDetailTab(v)} className="flex flex-1 flex-col overflow-hidden">
          <TabsList variant="line" className="shrink-0 border-b px-3">
            <TabsTrigger value="preview">Preview</TabsTrigger>
            <TabsTrigger value="metadata">Metadata</TabsTrigger>
          </TabsList>

          <TabsContent value="preview" className="min-h-0 flex-1 overflow-auto p-3">
            <div className="space-y-4">
              <div className="flex items-center justify-end gap-1">
                <PreviewModeButton
                  active={previewMode === "preview"}
                  onClick={() => setPreviewMode("preview")}
                >
                  Formatted
                </PreviewModeButton>
                <PreviewModeButton
                  active={previewMode === "json"}
                  onClick={() => setPreviewMode("json")}
                >
                  JSON
                </PreviewModeButton>
              </div>

              <CallDetailTabs
                data={effectiveInput}
                title="Input"
                viewMode={previewMode}
                comment={readOnly ? undefined : {
                  objectId: call.id,
                  objectType: "observation",
                  projectId: run?.run?.project,
                  dataField: "input",
                }}
                onCommentCreated={readOnly ? undefined : refreshCommentCounts}
              />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-[11px] font-medium text-muted-foreground">
                    Output
                  </div>
                  {canCorrect && previewMode === "preview" && !readOnly && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setShowCorrectionDialog(true)}
                    >
                      <Pencil className="h-3 w-3" />
                      {correctedOutput ? "Edit correction" : "Correct"}
                    </Button>
                  )}
                </div>
                {correctedOutput && outputText && previewMode === "preview" ? (
                  <DiffView original={outputText} corrected={correctedOutput} />
                ) : (
                  <CallDetailTabs
                    data={buildTracePreviewData(effectiveOutput, call.metadata)}
                    title=""
                    viewMode={previewMode}
                    comment={readOnly ? undefined : {
                      objectId: call.id,
                      objectType: "observation",
                      projectId: run?.run?.project,
                      dataField: "output",
                    }}
                    onCommentCreated={readOnly ? undefined : refreshCommentCounts}
                  />
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="metadata" className="flex-1 overflow-auto p-3">
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
              <MetadataRow label="Tokens" value={call.total_tokens != null && call.total_tokens > 0 ? (call.prompt_tokens != null || call.completion_tokens != null ? formatTokenBreakdown(call.prompt_tokens ?? 0, call.completion_tokens ?? 0) : formatTokenTotal(call.total_tokens)) : "\u2014"} />
              <MetadataRow label="Cost" value={call.cost != null ? <CallCostBreakdownTooltip breakdown={call.cost_breakdown} rawUsage={call.raw_usage} modelName={call.model} provenance={call.cost_provenance} cost={call.cost}><span className="font-mono">{formatCostMicro(call.cost)}</span></CallCostBreakdownTooltip> : "\u2014"} />
              {call.end_time ? <MetadataRow label="Ended" value={formatDate(call.end_time)} /> : null}
              {call.status_message ? <MetadataRow label="Status" value={<span className={call.level === "ERROR" ? "text-destructive font-medium" : ""}>{call.status_message}</span>} /> : null}
              {call.environment && call.environment !== "default" ? <MetadataRow label="Environment" value={<span className="inline-flex items-center border border-border/70 bg-muted/10 px-1.5 py-0.5 text-[11px]">{call.environment}</span>} /> : null}
              {call.session_id ? <MetadataRow label="Session" value={<span className="font-mono text-xs">{call.session_id}</span>} /> : null}
              {call.tags?.length ? <MetadataRow label="Tags" value={<div className="flex flex-wrap gap-1 justify-end">{call.tags.map((tag: string) => <span key={tag} className="inline-flex items-center border border-border/70 bg-muted/10 px-1.5 py-0.5 text-[11px]">{tag}</span>)}</div>} /> : null}
              {call.version ? <MetadataRow label="Version" value={<span className="font-mono text-xs">{call.version}</span>} /> : null}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {showCorrectionDialog && outputText !== null && !readOnly && (
        <CorrectionDialog
          original={outputText}
          currentCorrection={correctedOutput}
          onSave={handleSaveCorrection}
          onClose={() => setShowCorrectionDialog(false)}
        />
      )}
    </div>
  );
}

function HeaderPill({
  children,
  mono = false,
}: {
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <span className={`inline-flex items-center border border-border/70 bg-muted/10 px-1.5 py-0.5 text-[11px] text-muted-foreground ${mono ? "font-mono" : ""}`}>
      {children}
    </span>
  );
}

function ItemTypeBadge({ type }: { type?: string | null }) {
  const label = typeof type === "string" && type.length > 0 ? type.toUpperCase() : "SPAN";
  return (
    <span className="inline-flex items-center border border-border/70 bg-muted/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {label}
    </span>
  );
}

function MetadataRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/60 py-2 last:border-b-0">
      <div className="text-[11px] text-muted-foreground">
        {label}
      </div>
      <div className="text-right text-sm text-foreground">{value}</div>
    </div>
  );
}

const shortDateTimeFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

function formatDate(v: string | null) {
  if (!v) return "—";
  return shortDateTimeFormatter.format(new Date(v));
}

function formatEventLabel(t: string) {
  return t === "tool_use" ? "Tool Call" : t.split("_").map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
}

function getModelShort(model: string) {
  const s = model.split("/").at(-1) ?? model;
  return s.length > 18 ? `${s.slice(0, 18)}...` : s;
}

function buildTracePreviewData(data: any, metadata?: Record<string, unknown> | null) {
  if (!data || typeof data !== "object" || !metadata || typeof metadata !== "object") return data;
  const eventType = typeof metadata.eventType === "string" ? metadata.eventType : undefined;
  if (!eventType) return data;
  return { ...data, type: eventType ?? data.type, metadata };
}

function PreviewModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={active
        ? "border border-border/80 bg-muted/10 px-1.5 py-0.5 text-[11px] text-foreground"
        : "px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"}
    >
      {children}
    </button>
  );
}

function getObservationType(call: any) {
  const eventType = getEventType(call);
  if (call.tool_name || eventType === "tool_use") {
    return "tool";
  }
  if (call.model && call.model !== "unknown") {
    return "generation";
  }
  return call.call_type || "span";
}

function formatMetaParts(parts: Array<string | null>) {
  return parts.filter(Boolean) as string[];
}

function extractOutputText(output: any): string | null {
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object") return null;
  if (typeof output.text === "string") return output.text;
  if (typeof output.content === "string") return output.content;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return null;
  }
}

function formatParamValue(value: unknown): string {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
  }
  const str = String(value);
  return str.length > 20 ? `${str.slice(0, 20)}...` : str;
}

const MODEL_PARAM_KEYS = [
  "temperature", "max_tokens", "top_p", "frequency_penalty",
  "presence_penalty", "stop", "response_format", "seed",
];

function extractModelParams(call: any): Record<string, unknown> | null {
  const meta = call.metadata ?? call.meta;
  if (!meta || typeof meta !== "object") return null;

  const params: Record<string, unknown> = {};
  for (const key of MODEL_PARAM_KEYS) {
    if (meta[key] !== undefined) params[key] = meta[key];
    else if (meta.params?.[key] !== undefined) params[key] = meta.params[key];
    else if (meta.modelParams?.[key] !== undefined) params[key] = meta.modelParams[key];
  }

  return Object.keys(params).length > 0 ? params : null;
}

function getAncestorPath(call: any, allCalls: any[]): any[] {
  const byId = new Map(allCalls.map((c: any) => [c.id, c]));
  const path: any[] = [call];
  let current = call;
  while (current.parent_call_id) {
    const parent = byId.get(current.parent_call_id);
    if (!parent) break;
    path.unshift(parent);
    current = parent;
  }
  return path;
}
