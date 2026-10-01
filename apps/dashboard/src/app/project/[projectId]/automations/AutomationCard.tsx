"use client";

import { useCallback, useState } from "react";
import { ChevronDown, ChevronRight, FlaskConical, Pencil, Trash2 } from "lucide-react";
import {
  type AutomationExecution,
  type AutomationSummary,
  deleteAutomation,
  formatWindowValue,
  listAutomationExecutions,
  testAutomation,
  triggerSentence,
} from "@/lib/automations-api";
import { formatUtcTimestamp } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface AutomationCardProps {
  automation: AutomationSummary;
  manageable: boolean;
  onToggle: (automation: AutomationSummary) => void;
  onRotate: (automation: AutomationSummary) => void;
  onDelete: (id: string) => void;
  onEdit: (automation: AutomationSummary) => void;
  onError: (message: string | null) => void;
}

function describeAction(automation: AutomationSummary): string {
  if (automation.action_type === "slack") {
    return `Slack → ${String(automation.action_config.url_display ?? "channel")}`;
  }
  if (automation.action_type === "webhook") {
    return `Webhook → ${String(automation.action_config.url ?? "")}`;
  }
  const owner = String(automation.action_config.owner ?? "");
  const repo = String(automation.action_config.repo ?? "");
  return `GitHub issue → ${owner}/${repo}`;
}

function describeConditions(automation: AutomationSummary): string {
  if (automation.conditions.length === 0) return "Every event of this type";
  return automation.conditions
    .map(
      (condition) =>
        `${condition.field} ${condition.operator} ${JSON.stringify(condition.value)}`,
    )
    .join(" and ");
}

export default function AutomationCard({
  automation,
  manageable,
  onToggle,
  onRotate,
  onDelete,
  onEdit,
  onError,
}: AutomationCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [executions, setExecutions] = useState<AutomationExecution[] | null>(null);
  const [loadingExecutions, setLoadingExecutions] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const handleExpand = useCallback(async () => {
    const next = !expanded;
    setExpanded(next);
    setTestResult(null);
    if (next && executions === null) {
      setLoadingExecutions(true);
      try {
        const page = await listAutomationExecutions(automation.id);
        setExecutions(page.executions);
      } catch (e: unknown) {
        onError(e instanceof Error ? e.message : "Failed to load executions");
      } finally {
        setLoadingExecutions(false);
      }
    }
  }, [automation.id, expanded, executions, onError]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testAutomation(automation.id);
      setTestResult(
        result.success
          ? "Test delivered successfully (a github_issue automation opened a real issue)."
          : `Test failed: ${result.error ?? "unknown error"}`,
      );
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : "Test delivery failed");
    } finally {
      setTesting(false);
    }
  }, [automation.id, onError]);

  const handleDelete = useCallback(async () => {
    onError(null);
    try {
      await deleteAutomation(automation.id);
      onDelete(automation.id);
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : "Failed to delete automation");
    }
  }, [automation.id, onDelete, onError]);

  const disabled = !automation.enabled;

  return (
    <article
      className="border border-border"
      aria-label={`Automation ${automation.name}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-sm font-medium">{automation.name}</h2>
            {automation.enabled ? (
              <Badge variant="secondary">Active</Badge>
            ) : (
              <Badge variant="outline">Disabled</Badge>
            )}
            {automation.enabled && automation.was_breached ? (
              <Badge variant="destructive">Breached</Badge>
            ) : null}
            {automation.consecutive_failures > 0 ? (
              <Badge variant="destructive">
                {automation.consecutive_failures} consecutive failures
              </Badge>
            ) : null}
          </div>
          <dl className="mt-2 grid gap-1 text-xs text-muted-foreground">
            <div className="flex gap-2">
              <dt className="shrink-0">When</dt>
              <dd className="break-all">
                {automation.trigger_kind === "window"
                  ? triggerSentence(automation)
                  : `${automation.event_type} — ${describeConditions(automation)}`}
              </dd>
            </div>
            {automation.trigger_kind === "window" ? (
              <div className="flex gap-2">
                <dt className="shrink-0">Current value</dt>
                <dd className="font-mono tabular-nums">
                  <span
                    className={
                      automation.enabled && automation.was_breached
                        ? "text-destructive"
                        : ""
                    }
                  >
                    {formatWindowValue(
                      automation.window_metric,
                      automation.last_evaluated_value,
                    )}
                  </span>
                  {automation.last_evaluated_at
                    ? ` · evaluated ${formatUtcTimestamp(automation.last_evaluated_at)}`
                    : " · not evaluated yet"}
                </dd>
              </div>
            ) : null}
            <div className="flex gap-2">
              <dt className="shrink-0">Then</dt>
              <dd className="break-all">{describeAction(automation)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0">Last delivery</dt>
              <dd>
                {formatUtcTimestamp(automation.last_delivery_at)}
                {automation.last_delivery_status
                  ? ` (${automation.last_delivery_status})`
                  : ""}
              </dd>
            </div>
          </dl>
        </div>
        {manageable ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={handleTest}
              disabled={testing || disabled}
            >
              <FlaskConical className="size-4" aria-hidden />
              Test
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => onToggle(automation)}
            >
              {automation.enabled ? "Disable" : "Enable"}
            </Button>
            {automation.action_type === "webhook" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => onRotate(automation)}
              >
                Rotate Secret
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => onEdit(automation)}
            >
              <Pencil className="size-4" aria-hidden />
              Edit
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-destructive"
              onClick={handleDelete}
            >
              <Trash2 className="size-4" aria-hidden />
              Delete
            </Button>
          </div>
        ) : null}
      </div>

      {testResult ? (
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          {testResult}
        </p>
      ) : null}

      <button
        type="button"
        className="flex w-full items-center gap-1 border-t border-border px-4 py-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={handleExpand}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-4" aria-hidden />
        ) : (
          <ChevronRight className="size-4" aria-hidden />
        )}
        Execution log
      </button>

      {expanded ? (
        <div className="border-t border-border p-4">
          {loadingExecutions ? (
            <p className="text-xs text-muted-foreground">Loading executions…</p>
          ) : !executions || executions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No executions yet — this automation has not fired.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {executions.map((execution) => (
                <li
                  key={execution.id}
                  className="border border-border/60 p-2 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        execution.status === "completed"
                          ? "secondary"
                          : execution.status === "error"
                            ? "destructive"
                            : "outline"
                      }
                    >
                      {execution.status}
                    </Badge>
                    <span className="text-muted-foreground">
                      {formatUtcTimestamp(execution.created_at)}
                    </span>
                    <span className="text-muted-foreground">
                      {execution.event_type}
                    </span>
                  </div>
                  {execution.error ? (
                    <p className="mt-1 break-all text-destructive">
                      {execution.error}
                    </p>
                  ) : null}
                  {execution.output && typeof execution.output.issue_url === "string" ? (
                    <a
                      className="mt-1 block break-all underline"
                      href={execution.output.issue_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {execution.output.issue_url}
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </article>
  );
}
