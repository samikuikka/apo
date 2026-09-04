"use client";

import { useState, useCallback, useReducer } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CorrectionDialog } from "./CorrectionDialog";
import { CallDetailHeader } from "./CallDetailHeader";
import { CallPreviewTab } from "./CallPreviewTab";
import { CallMetadataTab } from "./CallMetadataTab";
import { useTraceData, type LoggedCall } from "./contexts/TraceDataContext";
import { useSelection } from "./contexts/SelectionContext";
import { saveCorrection } from "@/lib/traces-api";
import { extractOutputText } from "./call-detail-utils";
import { useCallPayload } from "./use-call-payload";

const VALID_CALL_TABS = new Set(["preview", "metadata"]);

/**
 * Correction mini-machine: the dialog's open flag and the current correction
 * text change together (saving closes the dialog and updates the text in one
 * transition), so they live in one reducer instead of two useStates.
 */
type CorrectionState = { open: boolean; corrected: string | null };
type CorrectionAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "saved"; corrected: string | null };

function correctionReducer(state: CorrectionState, action: CorrectionAction): CorrectionState {
  switch (action.type) {
    case "open":
      return { ...state, open: true };
    case "close":
      return { ...state, open: false };
    case "saved":
      return { open: false, corrected: action.corrected };
  }
}

export function CallDetailView({ call: slimCall }: { call: LoggedCall }) {
  const { selectCall, detailTab, setDetailTab } = useSelection();
  const { run, cumulativeMetrics } = useTraceData();
  const runId = run?.run?.id ?? "";
  const projectId = run?.run?.project;
  // The trace was fetched slim (call metadata + previews): resolve the full
  // payload for the selected call on demand instead of shipping every call's
  // megabyte-scale I/O with the page.
  const { call, loading: payloadLoading, error: payloadError, retry: retryPayload } =
    useCallPayload(runId, projectId, slimCall, run?.slim_calls === true);
  // Bumped when an inline comment is created so the drawer re-fetches.
  const [commentNonce, setCommentNonce] = useState(0);
  const refreshCommentCounts = useCallback(
    () => setCommentNonce((n) => n + 1),
    [],
  );
  const [correction, dispatchCorrection] = useReducer(correctionReducer, {
    open: false,
    corrected: call.corrected_output ?? null,
  });
  const section = VALID_CALL_TABS.has(detailTab)
    ? (detailTab as "preview" | "metadata")
    : "preview";
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
  const outputText = extractOutputText(effectiveOutput);

  const handleSaveCorrection = useCallback(async (text: string | null) => {
    try {
      const result = await saveCorrection(runId, call.id, text);
      dispatchCorrection({ type: "saved", corrected: result.corrected_output });
      call.corrected_output = result.corrected_output;
    } catch (err) {
      console.error("Failed to save correction:", err);
    }
  }, [runId, call]);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <CallDetailHeader
        call={call}
        run={run}
        cumulativeMetrics={cumulativeMetrics}
        selectCall={selectCall}
        commentNonce={commentNonce}
      />

      {(payloadLoading || payloadError) && (
        <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-1 text-[11px] text-muted-foreground">
          {payloadLoading ? (
            <>
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-muted-foreground/50" />
              Loading call payload…
            </>
          ) : (
            <>
              <span className="text-destructive">Could not load call payload.</span>
              <button type="button" onClick={retryPayload} className="underline underline-offset-2 hover:text-foreground">
                Retry
              </button>
            </>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Tabs value={section} onValueChange={(v) => setDetailTab(v)} className="flex flex-1 flex-col overflow-hidden">
          <TabsList variant="line" className="shrink-0 border-b px-3">
            <TabsTrigger value="preview">Preview</TabsTrigger>
            <TabsTrigger value="metadata">Metadata</TabsTrigger>
          </TabsList>

          <TabsContent value="preview" className="min-h-0 flex-1 overflow-auto p-3">
            <CallPreviewTab
              call={call}
              run={run}
              effectiveInput={effectiveInput}
              effectiveOutput={effectiveOutput}
              outputText={outputText}
              correctedOutput={correction.corrected}
              onOpenCorrectionDialog={() => dispatchCorrection({ type: "open" })}
              onCommentCreated={refreshCommentCounts}
            />
          </TabsContent>

          <TabsContent value="metadata" className="flex-1 overflow-auto p-3">
            <CallMetadataTab call={call} run={run} />
          </TabsContent>
        </Tabs>
      </div>

      {correction.open && outputText !== null && (
        <CorrectionDialog
          original={outputText}
          currentCorrection={correction.corrected}
          onSave={handleSaveCorrection}
          onClose={() => dispatchCorrection({ type: "close" })}
        />
      )}
    </div>
  );
}
