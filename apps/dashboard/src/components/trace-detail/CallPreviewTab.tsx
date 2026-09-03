"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CallDetailTabs } from "./CallDetailTabs";
import { GenerationChatPreview } from "./GenerationChatPreview";
import { DiffView } from "./DiffView";
import { PreviewModeButton } from "./PreviewModeButton";
import { buildTracePreviewData, isChatMlInput } from "./call-detail-utils";

interface CallPreviewTabProps {
  call: any;
  run: any;
  /** Unified input: tool parameters for TOOL observations, else call.input. */
  effectiveInput: any;
  /** Unified output: tool result for TOOL observations, else call.output. */
  effectiveOutput: any;
  /** Text projection of effectiveOutput (drives correction affordances). */
  outputText: string | null;
  /** Current corrected output owned by CallDetailView's correction reducer. */
  correctedOutput: string | null;
  onOpenCorrectionDialog: () => void;
  /** Bumps the header drawer's comment nonce after an inline comment. */
  onCommentCreated: () => void;
}

export function CallPreviewTab({
  call,
  run,
  effectiveInput,
  effectiveOutput,
  outputText,
  correctedOutput,
  onOpenCorrectionDialog,
  onCommentCreated,
}: CallPreviewTabProps) {
  const [previewMode, setPreviewMode] = useState<"preview" | "json">("preview");
  const canCorrect = outputText !== null;

  // SPEC: generation I/O as one combined conversation (Langfuse model) when the
  // input is a ChatML messages array. Skipped when a correction is being shown
  // (DiffView needs the split output panel) and in JSON mode. Non-generation
  // observations and non-ChatML inputs keep the legacy split Input/Output panels.
  const useCombinedGenerationChat =
    (call.observation_type ?? "").toUpperCase() === "GENERATION"
    && previewMode === "preview"
    && !(correctedOutput && outputText)
    && isChatMlInput(effectiveInput);

  return (
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

      {useCombinedGenerationChat ? (
        <GenerationChatPreview input={effectiveInput} output={effectiveOutput} />
      ) : (
        <>
          <CallDetailTabs
            data={effectiveInput}
            title="Input"
            viewMode={previewMode}
            comment={{
              objectId: call.id,
              objectType: "observation",
              projectId: run?.run?.project,
              dataField: "input",
            }}
            onCommentCreated={onCommentCreated}
          />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium text-muted-foreground">
                Output
              </div>
              {canCorrect && previewMode === "preview" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={onOpenCorrectionDialog}
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
                comment={{
                  objectId: call.id,
                  objectType: "observation",
                  projectId: run?.run?.project,
                  dataField: "output",
                }}
                onCommentCreated={onCommentCreated}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
