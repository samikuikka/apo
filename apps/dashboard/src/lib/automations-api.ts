import { apiClient } from "./api-client";

// ============================================================================
// Types
// ============================================================================

export type AutomationEventType =
  | "batch_run.completed"
  | "batch_run.failed"
  | "task_run.started"
  | "task_run.completed"
  | "task_run.error"
  | "task_run.trace_claimed"
  /** Synthetic type of window-automation breaches (evaluator-fired). */
  | "window.breached";

export type AutomationActionType = "webhook" | "github_issue" | "slack";

/** "event" matches a single run event; "window" evaluates an aggregate over
 * a time window and fires on a threshold crossing (the monitor flavor). */
export type AutomationTriggerKind = "event" | "window";

export type WindowMetricId =
  | "suite_pass_rate"
  | "checks_pass_rate"
  | "failed_tasks"
  | "failed_checks"
  | "errored_tasks"
  | "error_rate"
  | "total_cost"
  | "avg_cost"
  | "peak_cost"
  | "avg_duration_s"
  | "peak_duration_s"
  | "p95_duration_s"
  | "total_tokens";

export type WindowOperator = "lt" | "gt" | "gte";

export type EvaluationWindow = "1h" | "6h" | "24h" | "7d";

export const WINDOW_METRIC_LABELS: Record<WindowMetricId, string> = {
  suite_pass_rate: "Suite pass rate",
  checks_pass_rate: "Checks pass rate",
  failed_tasks: "Failed tasks",
  failed_checks: "Failed checks",
  errored_tasks: "Errored tasks",
  error_rate: "Error rate",
  total_cost: "Total cost",
  avg_cost: "Average cost",
  peak_cost: "Peak cost",
  avg_duration_s: "Average duration",
  peak_duration_s: "Peak duration",
  p95_duration_s: "P95 duration",
  total_tokens: "Total tokens",
};

/** Where-filters the window query can apply (mirrors the backend's
 * WINDOW_CONDITION_FIELDS; provider needs JSON containment SQL — follow-up). */
export const WINDOW_CONDITION_FIELDS = [
  "environment",
  "task",
  "model",
  "trigger.source",
] as const;

export interface AutomationCondition {
  field: string;
  operator: string;
  value: unknown;
}

export interface AutomationSummary {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  event_type: AutomationEventType;
  trigger_kind: AutomationTriggerKind;
  conditions: AutomationCondition[];
  window_metric: WindowMetricId | null;
  window_operator: WindowOperator | null;
  window_threshold: number | null;
  evaluation_window: EvaluationWindow | null;
  was_breached: boolean;
  last_evaluated_at: string | null;
  last_evaluated_value: number | null;
  action_type: AutomationActionType;
  action_config: Record<string, unknown>;
  enabled: boolean;
  consecutive_failures: number;
  last_delivery_at: string | null;
  last_delivery_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutomationCreateResponse extends AutomationSummary {
  /** Present only for webhook actions: the one-time signing secret. */
  secret?: string | null;
}

export interface AutomationCreateRequest {
  project_id: string;
  name: string;
  description?: string | null;
  event_type?: AutomationEventType;
  trigger_kind?: AutomationTriggerKind;
  conditions: AutomationCondition[];
  window_metric?: WindowMetricId | null;
  window_operator?: WindowOperator | null;
  window_threshold?: number | null;
  evaluation_window?: EvaluationWindow | null;
  action_type: AutomationActionType;
  action_config: Record<string, unknown>;
  github_token?: string | null;
}

export interface AutomationExecution {
  id: string;
  event_type: string;
  status: "pending" | "completed" | "error";
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface AutomationEvaluation {
  metric: WindowMetricId | null;
  window: EvaluationWindow | null;
  value: number | null;
  threshold: number | null;
  operator: WindowOperator | null;
  breached: boolean;
}

// ============================================================================
// API helpers
// ============================================================================

const NO_CACHE = { cache: "no-store" } as const;

export function listAutomations(projectId: string): Promise<AutomationSummary[]> {
  return apiClient("/v1/automations", {
    ...NO_CACHE,
    query: { project_id: projectId },
  });
}

export function createAutomation(
  request: AutomationCreateRequest,
): Promise<AutomationCreateResponse> {
  return apiClient("/v1/automations", { method: "POST", body: request });
}

export interface AutomationPatch
  extends Partial<
    Pick<
      AutomationSummary,
      | "name"
      | "description"
      | "enabled"
      | "event_type"
      | "trigger_kind"
      | "conditions"
      | "window_metric"
      | "window_operator"
      | "window_threshold"
      | "evaluation_window"
      | "action_config"
    >
  > {
  /** Non-empty string replaces the stored token; omitted keeps it. */
  github_token?: string | null;
}

export function updateAutomation(
  automationId: string,
  patch: AutomationPatch,
): Promise<AutomationSummary> {
  return apiClient(`/v1/automations/${encodeURIComponent(automationId)}`, {
    method: "PATCH",
    body: patch,
  });
}

export function deleteAutomation(automationId: string): Promise<void> {
  return apiClient(`/v1/automations/${encodeURIComponent(automationId)}`, {
    method: "DELETE",
  });
}

export function rotateAutomationSecret(
  automationId: string,
): Promise<{ id: string; secret: string }> {
  return apiClient(
    `/v1/automations/${encodeURIComponent(automationId)}/rotate-secret`,
    { method: "POST" },
  );
}

export function testAutomation(
  automationId: string,
): Promise<{ success: boolean; error: string | null }> {
  return apiClient(`/v1/automations/${encodeURIComponent(automationId)}/test`, {
    method: "POST",
  });
}

export function getAutomationEvaluation(
  automationId: string,
): Promise<AutomationEvaluation> {
  return apiClient(
    `/v1/automations/${encodeURIComponent(automationId)}/evaluation`,
    NO_CACHE,
  );
}

export function listAutomationExecutions(
  automationId: string,
  limit = 50,
): Promise<{ executions: AutomationExecution[] }> {
  return apiClient(
    `/v1/automations/${encodeURIComponent(automationId)}/executions`,
    { ...NO_CACHE, query: { limit: String(limit) } },
  );
}

/** Human sentence for either trigger kind, e.g. "Suite pass rate < 80% over
 * 24h" or "batch_run.failed · trigger.source = schedule". */
export function triggerSentence(automation: AutomationSummary): string {
  if (automation.trigger_kind === "window") {
    const metric =
      automation.window_metric !== null
        ? (WINDOW_METRIC_LABELS[automation.window_metric] ?? automation.window_metric)
        : "unknown metric";
    const operator = automation.window_operator === "lt" ? "<" : automation.window_operator === "gt" ? ">" : "≥";
    const threshold = formatWindowThreshold(
      automation.window_metric,
      automation.window_threshold,
    );
    return `${metric} ${operator} ${threshold} over ${automation.evaluation_window ?? "?"}`;
  }
  const conditions = automation.conditions
    .map((c) => `${c.field} ${c.operator} ${String(c.value)}`)
    .join(" · ");
  return conditions ? `${automation.event_type} · ${conditions}` : automation.event_type;
}

export function formatWindowValue(
  metric: WindowMetricId | null,
  value: number | null,
): string {
  if (value === null || Number.isNaN(value)) return "—";
  if (
    metric === "suite_pass_rate" ||
    metric === "checks_pass_rate" ||
    metric === "error_rate"
  ) {
    return `${Math.round(value * 100)}%`;
  }
  if (metric === "total_cost" || metric === "avg_cost" || metric === "peak_cost") {
    return Math.abs(value) >= 10000
      ? `$${Intl.NumberFormat("en-US", { notation: "compact" }).format(value)}`
      : `$${value.toFixed(2)}`;
  }
  if (
    metric === "avg_duration_s" ||
    metric === "peak_duration_s" ||
    metric === "p95_duration_s"
  ) {
    return `${value.toFixed(1)}s`;
  }
  if (metric === "total_tokens") {
    return Intl.NumberFormat("en-US", { notation: "compact" }).format(value);
  }
  return String(Math.round(value));
}

function formatWindowThreshold(
  metric: WindowMetricId | null,
  threshold: number | null,
): string {
  if (threshold === null) return "?";
  return formatWindowValue(metric, threshold);
}
