"use client";

import { Code2, FileText, MessageSquare, ExternalLink } from "lucide-react";
import { useUrlParam } from "@/hooks/use-url-state";
import { ConversationTranscript } from "@/components/agent-task-execution/conversation-transcript";
import { DeliverablesPanel } from "@/components/agent-task-execution/deliverables-panel";
import type { DeliverableSummary } from "@/lib/agent-task-deliverables-api";
import type { CheckResult, TaskDefinitionRevisionSummary } from "@/lib/agent-task-api";
import { ChecksList } from "./checks-list";
import { DeliverablesView } from "./deliverables-view";
import { useLazyConversation } from "./use-lazy-conversation";
import { useCheckSource } from "./use-check-source";
import { Panel } from "./panel";
import { TaskRunTabStrip, type TaskRunTab, type TaskRunTabId } from "./task-run-tab-strip";

// ── Main body ────────────────────────────────────────────────────────────

export function TaskRunDetailBody({
  checks,
  deliverables,
  deliverableItems,
  traceRunId,
  projectId,
  commitSha,
  taskId,
  sourceType,
  taskDefinition,
  taskRunId,
  correctable = false,
}: {
  checks: CheckResult[];
  deliverables: Record<string, unknown> | null;
  deliverableItems: DeliverableSummary[];
  traceRunId: string | null;
  projectId?: string | null;
  commitSha?: string | null;
  taskId: string;
  sourceType?: string | null;
  taskDefinition?: TaskDefinitionRevisionSummary | null;
  taskRunId?: string | null;
  /** Terminal verdict-bearing run with recorded checks. */
  correctable?: boolean;
}) {
  // Active tab lives in the URL (?tab=) so a shared link lands the reader on
  // the same view (checks / transcript / deliverables).
  const [tabParam, setTabParam] = useUrlParam("tab");
  const tab: TaskRunTabId =
    tabParam === "transcript" || tabParam === "deliverables" ? tabParam : "checks";

  const conversationState = useLazyConversation(
    traceRunId,
    projectId,
    tab === "transcript",
  );

  const checksSource = useCheckSource({
    checks,
    taskDefinition,
    taskRunId,
    taskId,
    projectId,
    commitSha,
    sourceType,
  });

  const checksPassed = checks.filter((check) => check.pass === true).length;
  const failedCount = checks.length - checksPassed;

  const tabs: TaskRunTab[] = [
    { id: "checks", label: "Checks", icon: Code2, count: checks.length },
    { id: "transcript", label: "Conversation History", icon: MessageSquare },
    { id: "deliverables", label: "Deliverables", icon: FileText },
  ];

  if (traceRunId) {
    tabs.push({ id: "trace", label: "Trace home", icon: ExternalLink });
  }

  return (
    <>
      <TaskRunTabStrip
        tabs={tabs}
        activeTab={tab}
        onSelectTab={(next) => setTabParam(next)}
        traceRunId={traceRunId}
      />

      <div className="space-y-4 px-6 py-5">
        {tab === "checks" && (
          <>
            {checks.length > 0 && (
              <div className="flex items-center justify-between text-[12px]">
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground">
                    <span className="font-medium text-foreground">{checksPassed}</span>/{checks.length} passed
                  </span>
                  {failedCount > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">
                      {failedCount} failed
                    </span>
                  )}
                </div>
                <span className="text-muted-foreground/60">Click to expand</span>
              </div>
            )}

            {checksSource && (
              <p className="text-[11px] text-muted-foreground/70">
                Expand a code check to see its source with the failing line marked.
              </p>
            )}
            {!checksSource && checks.length > 0 && sourceType === "published" && (
              <p className="text-[11px] text-muted-foreground/70">
                Check source remains on the machine that executed this task — published task catalogs carry metadata only.
              </p>
            )}

            {checks.length > 0 && (
              <Panel padded={false}>
                <ChecksList
                  checks={checks}
                  checksSource={checksSource}
                  correctable={correctable}
                  taskRunId={taskRunId ?? undefined}
                />
              </Panel>
            )}

            {checks.length === 0 && (
              <p className="py-4 text-center text-sm text-muted-foreground">No checks recorded</p>
            )}
          </>
        )}

        {tab === "transcript" && (
          conversationState.status === "ready" ? (
            <ConversationTranscript
              conversation={conversationState.messages}
              traceRunId={traceRunId}
            />
          ) : conversationState.status === "error" ? (
            <p className="py-4 text-center text-sm text-destructive">
              Failed to load transcript: {conversationState.message}
            </p>
          ) : (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Loading transcript…
            </p>
          )
        )}

        {tab === "deliverables" && (
          deliverableItems.length > 0 ? (
            <DeliverablesPanel items={deliverableItems} />
          ) : deliverables ? (
            <DeliverablesView deliverables={deliverables} />
          ) : (
            <p className="py-4 text-center text-sm text-muted-foreground">No deliverables recorded</p>
          )
        )}
      </div>
    </>
  );
}
