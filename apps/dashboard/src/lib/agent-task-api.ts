import { apiClient } from "./api-client";
import { ApiError } from "./api-error";
import type { DeliverableSummary } from "./agent-task-deliverables-api";

// ============================================================================
// Types
// ============================================================================

export type TracePersistenceStatus = "pending" | "persisted" | "failed";

export interface AgentTaskRunStats {
  total_runs: number;
  passed_runs: number;
  failed_runs: number;
  errored_runs: number;
  pass_rate: number;
  avg_duration_ms: number | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_passed: boolean | null;
  total_checks: number;
  checks_pass_rate: number;
  avg_cost: number | null;
}

export interface AgentTaskSummary {
  id: string;
  task_path: string;
  folder_path: string;
  display_name: string;
  adapter_name: string;
  has_checks: boolean;
  tags: string[];
  run_stats: AgentTaskRunStats | null;
}

export interface AgentTaskDetail extends AgentTaskSummary {
  latest_run: AgentTaskRunSummary | null;
}

export interface AgentTaskRunTrigger {
  source: string | null;
  actor: string | null;
  hostname: string | null;
  user_agent: string | null;
  entrypoint: string | null;
  initiated_at: string | null;
  ci_system: string | null;
  ci_run_id: string | null;
  ci_run_url: string | null;
  repository: string | null;
  branch: string | null;
  commit_sha: string | null;
  pr_number: string | null;
  schedule_id: string | null;
  schedule_name: string | null;
}

export interface FailureBreakdownItem {
  category: string;
  label: string;
  count: number;
}

// adapter-reported Run Configuration (typed, indexed dimensions).
export interface AgentTaskRunConfiguration {
  model: string;
  effort: string | null;
}

export type BatchRunConfigurationState = "uniform" | "mixed" | "partial" | "unknown";

export interface EffortFacetOption {
  effort: string;
  count: number;
}

export interface ModelFacetOption {
  model: string;
  count: number;
  efforts: EffortFacetOption[];
  /** Retired from the filter dropdowns by a project member. */
  archived: boolean;
}

export interface PaginatedBatchRunSummary {
  data: AgentTaskBatchRunSummary[];
  total_count: number;
  page: number;
  page_size: number;
  total_pages: number;
  model_facets: ModelFacetOption[];
}

export interface AgentTaskRunConfigurationCount extends AgentTaskRunConfiguration {
  task_runs: number;
}

export interface AgentTaskBatchRunConfigurationSummary {
  state: BatchRunConfigurationState;
  configurations: AgentTaskRunConfigurationCount[];
  reported_task_runs: number;
  total_task_runs: number;
}

/**
 * Canonical Task Run lifecycle, mirrored from the backend's
 * `TaskRunStatus` (models/schemas.py). "completed" is a *batch* status.
 * The union stays open (`string & {}`) so an unknown backend value remains
 * representable — the UI renders those with a raw-label fallback instead
 * of guessing, and this union documents + autocompletes the known set.
 */
export type AgentTaskRunStatus = "passed" | "failed" | "running" | "error" | "pending";
export type WireStatus = AgentTaskRunStatus | (string & {});

export interface AgentTaskRunSummary {
  id: string;
  batch_run_id: string;
  task_id: string;
  task_path: string;
  adapter_name: string | null;
  status: WireStatus;
  pass_result: boolean | null;
  started_at: string | null;
  completed_at: string | null;
  trace_run_id: string | null;
  /** Primary model the run executed under (denormalized from the trace). */
  primary_model: string | null;
  task_source_commit_sha: string | null;
  error_message: string | null;
  total_cost: number | null;
  unpriced_call_count?: number;
  generation_execution?: GenerationExecutionSummary | null;
  total_tokens: number | null;
  total_checks: number;
  passed_checks: number;
  failed_checks: number;
  /** Tests whose effective result differs from the recorded one. */
  corrected_tests?: number;
  trigger: AgentTaskRunTrigger | null;
  trace_persistence_status: TracePersistenceStatus;
  trace_error_message: string | null;
  error_category: string | null;
  /** adapter-reported model/effort. Absent when not reported. */
  run_configuration: AgentTaskRunConfiguration | null;
}

export interface GenerationExecutionSummary {
  total: number;
  errored: number;
  error_finish_reasons: Record<string, number>;
}

export type EvaluatorType = "llm" | "code" | "regex";

/** typed catalog selection stored on a source-owned Schedule. */
export type ScheduleSelection =
  | { kind: "tasks"; task_ids: string[] }
  | { kind: "folder"; folder_id: string }
  | { kind: "all" };

/** Source location of a failed code check — for inline, editor-style display. */
export interface CheckLocation {
  file: string;
  line: number;
  column?: number;
}

export interface JudgeMetadata {
  model?: string;
  prompt?: {
    system?: string;
    user?: string;
  };
  response?: string;
  tokens?: { input: number; output: number };
  cost?: number;
  latency_ms?: number;
  temperature?: number;
}

export interface CheckAssertionResult {
  id: string;
  pass: boolean;
  reasoning: string;
  expected?: string;
  /** Serialized scalar for code assertions; raw value for LLM judges. */
  received?: unknown;
  location?: CheckLocation;
  evaluator_type?: EvaluatorType;
  judge?: JudgeMetadata;
}

export interface CheckResult {
  id: string;
  pass: boolean;
  reasoning: string;
  instruction?: string;
  deliverable?: string;
  evaluator_type?: EvaluatorType;
  judge?: JudgeMetadata;
  /** For code checks: where in the source it failed (line-precise when captured). */
  location?: CheckLocation;
  /** The source filename this result came from (the `*.eval.ts` task file). */
  source_file?: string;
  /** Individual soft assertions recorded inside this check. */
  assertions?: CheckAssertionResult[];
  /** id of the describe() group this check was declared inside. */
  group_id?: string;
  /** display name of the enclosing describe() group. */
  group_name?: string;
  /**
   * Present only on corrected tests. `pass` is the effective
   * verdict; `recorded_pass` is what evaluation emitted; `correction`
   * carries the human decision's provenance. Uncorrected and legacy
   * results keep today's shape.
   */
  recorded_pass?: boolean;
  correction?: TestResultCorrection;
}

/** The active human correction on one test result. */
export interface TestResultCorrection {
  id: string;
  action: "set_pass" | "set_fail" | "clear";
  pass_result: boolean;
  reason: string;
  corrected_by_user_id: string | null;
  corrected_by_label: string | null;
  corrected_via: "session" | "api_key" | "open_dev";
  created_at: string;
}

/** Response of POST …/test-result-corrections. */
export interface CorrectedTestResult {
  test_id: string;
  recorded_pass: boolean;
  effective_pass: boolean;
  correction: TestResultCorrection | null;
  run_status: "passed" | "failed";
  run_pass_result: boolean;
  total_tests: number;
  passed_tests: number;
  failed_tests: number;
  corrected_tests: number;
}

export interface TaskDefinitionFileSummary {
  path: string;
  language: "typescript";
  size_bytes: number;
  lines: number;
}

export interface TaskDefinitionRevisionSummary {
  id: string;
  digest: string;
  files: TaskDefinitionFileSummary[];
  created_at: string | null;
}

export interface AgentTaskRunDetail extends AgentTaskRunSummary {
  checks_json: CheckResult[] | null;
  transcript_json: Record<string, unknown> | null;
  deliverables_json: Record<string, unknown> | null;
  deliverables?: DeliverableSummary[];
  error_category: string | null;
  /** Pinned Task Definition for CodeMirror source display. */
  task_definition?: TaskDefinitionRevisionSummary | null;
  /** Issue #159: recorded rejudge judgments. The verdict above stays canonical. */
  judgments_count?: number;
}

/** Issue #159: one judgment on a Task Run (original or rejudge). */
export interface AgentTaskJudgmentSummary {
  id: string;
  task_run_id: string;
  trigger: "original" | "rejudge";
  label: string | null;
  judge_model: string | null;
  judge_base_url: string | null;
  task_definition_revision_id: string | null;
  definition_revision_matches_run: boolean | null;
  samples: number;
  pass_result: boolean | null;
  total_checks: number;
  passed_checks: number;
  failed_checks: number;
  created_at: string | null;
}

export interface AgentTaskJudgmentsResponse {
  task_run_id: string;
  judgments: AgentTaskJudgmentSummary[];
}

export interface AgentTaskBatchRunSummary {
  id: string;
  project: string;
  selection_type: string;
  selection_query: Record<string, unknown> | null;
  task_root: string | null;
  grep: string | null;
  environment: string;
  status: string;
  total_tasks: number;
  passed_tasks: number;
  failed_tasks: number;
  errored_tasks: number;
  total_checks: number;
  passed_checks: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  trigger: AgentTaskRunTrigger | null;
  trace_persistence_status: TracePersistenceStatus;
  trace_error_message: string | null;
  total_cost: number | null;
  /** non-zero means total_cost is a partial sum (issue #147). */
  unpriced_call_count?: number;
  total_tokens: number | null;
  /** derived configuration summary (uniform/mixed/partial/unknown). */
  configuration: AgentTaskBatchRunConfigurationSummary;
}

export interface AgentTaskBatchRunDetail extends AgentTaskBatchRunSummary {
  run_metadata: Record<string, unknown> | null;
  cancelled_tasks: number;
  task_runs: AgentTaskRunSummary[];
  failure_breakdown: FailureBreakdownItem[];
  execution_target: ExecutionTarget | null;
  executor_pool_name: string | null;
  attempts: ExecutionAttemptSummary[];
}

export interface PoolExecutionTarget {
  kind: "pool";
  pool_id: string;
}

/** target for a dashboard Run through the User's Connected Executors. */
export interface SourceOwnedExecutionTarget {
  kind: "source_owned";
}

export type ExecutionTarget = PoolExecutionTarget | SourceOwnedExecutionTarget;

/** aggregate state of one member's Connected Executors. */
export type ConnectedEnvironmentState =
  | "ready"
  | "busy"
  | "offline"
  | "incompatible"
  | "catalog_mismatch"
  | "not_connected";

/** Dynamic waiting reason for a queued source-owned Attempt. */
export type AttemptWaitingReason = ConnectedEnvironmentState;

export interface ExecutionAttemptSummary {
  id: string;
  task_run_id: string;
  status: string;
  phase: string | null;
  assignment_kind: "caller" | "bundled" | "source_owned";
  executor_id: string | null;
  executor_name: string | null;
  executor_pool_id: string | null;
  driver_kind: string | null;
  queued_at: string;
  queue_expires_at: string | null;
  waiting_reason: AttemptWaitingReason | null;
  claimed_at: string | null;
  started_at: string | null;
  heartbeat_at: string | null;
  completed_at: string | null;
  failure_kind: string | null;
  error_message: string | null;
  cancel_requested_at: string | null;
}

/**
 * Mirrors the backend model exactly, which forbids extra fields: a run is
 * source-owned by definition, so `selection_type` and `execution_target` are
 * derived server-side and rejected on the request. Keep this in sync with
 * `CreateAgentTaskBatchRunRequest` in `backend/apo/models/schemas.py`.
 */
export interface CreateAgentTaskBatchRunRequest {
  project: string;
  /** exact catalog Task IDs. */
  task_ids: string[];
  environment?: string;
  run_metadata?: {
    trigger?: Partial<AgentTaskRunTrigger> | null;
    [key: string]: unknown;
  } | null;
}

export interface TaskFileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size_bytes: number | null;
  extension: string | null;
}

export interface TaskFileListResponse {
  task_id: string;
  task_path: string;
  files: TaskFileEntry[];
}

export interface TaskFileContentResponse {
  name: string;
  path: string;
  content: string;
  size_bytes: number;
  language: string;
  lines: number;
}

export interface ScheduleLastBatchSummary {
  id: string;
  status: string;
  total_tasks: number;
  passed_tasks: number;
  failed_tasks: number;
  errored_tasks: number;
  created_at: string;
  completed_at: string | null;
  failure_breakdown: FailureBreakdownItem[];
}

export interface AgentTaskScheduleSummary {
  id: string;
  project: string;
  name: string;
  selection_type: string;
  selection_query: Record<string, unknown> | null;
  task_root: string | null;
  grep: string | null;
  environment: string;
  cadence_type: string;
  timezone: string;
  hour: number;
  minute: number;
  day_of_week: number | null;
  day_of_month: number | null;
  min_interval_days: number;
  max_interval_days: number;
  enabled: boolean;
  executor_pool_id: string | null;
  queue_ttl_seconds: number;
  disabled_reason: string | null;
  last_triggered_at: string | null;
  last_batch_run_id: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  last_batch: ScheduleLastBatchSummary | null;
  consecutive_failures: number;
  // source-owned scheduled delivery projection.
  execution_kind: "source_owned" | "bundled";
  execution_owner: ScheduleExecutionOwnerSummary | null;
  connected_environment_state: ConnectedEnvironmentState | null;
  active_batch_run_id: string | null;
  latest_occurrence: ScheduleOccurrenceSummary | null;
  missed_occurrences: number;
}

export interface AgentTaskScheduleDetail extends AgentTaskScheduleSummary {
  run_metadata: Record<string, unknown> | null;
}

/** the fixed User whose Connected Executors run a source-owned Schedule. */
export interface ScheduleExecutionOwnerSummary {
  id: string;
  name: string;
}

export type ScheduleOccurrenceStatus =
  | "pending"
  | "delivered"
  | "missed"
  | "cancelled";

export type OccurrenceMissedReason =
  | "previous_occurrence_active"
  | "executor_unavailable"
  | "catalog_changed"
  | "selection_empty";

export interface ScheduleOccurrenceSummary {
  id: string;
  kind: "scheduled" | "manual";
  scheduled_for: string;
  status: ScheduleOccurrenceStatus;
  batch_run_id: string | null;
  missed_reason: OccurrenceMissedReason | null;
  resolved_at: string | null;
}

/** the active Batch (existing or newly created). */
export interface TriggerScheduleResponse {
  batch_run_id: string | null;
  occurrence_id: string | null;
  created: boolean;
  schedule: AgentTaskScheduleSummary;
}

export interface CreateAgentTaskScheduleRequest {
  project: string;
  name: string;
  selection_type?: string;
  /** typed catalog selection for source-owned schedules. */
  selection?: ScheduleSelection;
  task_paths?: string[];
  task_root?: string | null;
  grep?: string | null;
  environment?: string;
  cadence_type?: string;
  timezone?: string;
  hour?: number;
  minute?: number;
  day_of_week?: number | null;
  day_of_month?: number | null;
  min_interval_days?: number;
  max_interval_days?: number;
  enabled?: boolean;
  executor_pool_id?: string | null;
  queue_ttl_seconds?: number | null;
  run_metadata?: Record<string, unknown> | null;
}

export interface UpdateAgentTaskScheduleRequest {
  name?: string;
  task_paths?: string[] | null;
  task_root?: string | null;
  grep?: string | null;
  environment?: string | null;
  cadence_type?: string | null;
  timezone?: string | null;
  hour?: number | null;
  minute?: number | null;
  day_of_week?: number | null;
  day_of_month?: number | null;
  min_interval_days?: number | null;
  max_interval_days?: number | null;
  enabled?: boolean | null;
  executor_pool_id?: string | null;
  queue_ttl_seconds?: number | null;
  run_metadata?: Record<string, unknown> | null;
}

export interface AdaptiveTaskState {
  task_id: string;
  task_path: string;
  current_interval_days: number;
  ease_factor: number;
  consecutive_passes: number;
  last_run_at: string | null;
  last_status: string | null;
  next_run_at: string | null;
}

// ============================================================================
// API Functions
// ============================================================================

const NO_CACHE = { cache: "no-store" } as const;

/**
 * canonical project-scoped task list backed by persisted
 * inventory. Returns an empty array when the source is configured but has
 * no tasks yet (a valid ready state). Throws when the project has no
 * source configured yet (HTTP 404) — callers should branch on the project
 * payload first.
 */
export const listProjectAgentTasks = (
  projectId: string,
  grep?: string,
): Promise<AgentTaskSummary[]> =>
  apiClient(`/v1/projects/${encodeURIComponent(projectId)}/agent-tasks`, {
    ...NO_CACHE,
    query: { grep },
  });

/**
 * Resolve one project task through the inventory collection endpoint.
 *
 * Task ids are hierarchical (for example `claude-agent/data-extraction`).
 * Keeping the id in a query parameter avoids relying on encoded slashes in a
 * catch-all backend path, which can be decoded differently by SSR fetches and
 * production proxies. The exact-id check is still required because `grep` is
 * intentionally a substring search.
 */
export const getProjectAgentTask = async (
  projectId: string,
  taskId: string,
): Promise<AgentTaskDetail> => {
  const tasks = await listProjectAgentTasks(projectId, taskId);
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new ApiError(404, "Task not found in inventory.");
  }
  return { ...task, latest_run: null };
};

/**
 * Run-history cohort filters. These are the Tasks page evidence-view
 * dimensions (see `run-cohort`); a task-detail drill-down sends the active
 * view's values so the run list shows exactly the cohort the task card's
 * stats were scoped to.
 */
export interface TaskRunCohortFilter {
  /** `null` means the dimension is absent (the param is simply not sent). */
  model?: string | null;
  effort?: string | null;
  since?: string | null;
  /** OR'd run statuses (repeatable `?status=`). */
  status?: string[];
}

export const listTaskRuns = (
  taskId: string,
  project?: string,
  cohort?: TaskRunCohortFilter,
  limit?: number,
): Promise<AgentTaskRunSummary[]> =>
  apiClient("/v1/agent-task-runs", {
    ...NO_CACHE,
    query: {
      task_id: taskId,
      project,
      model: cohort?.model,
      effort: cohort?.effort,
      since: cohort?.since,
      status: cohort?.status,
      limit,
    },
  });

export const createAgentTaskBatchRun = (
  request: CreateAgentTaskBatchRunRequest,
): Promise<AgentTaskBatchRunDetail> =>
  apiClient("/v1/agent-task-batch-runs", { method: "POST", body: request });

export const listAgentTaskBatchRuns = (
  project?: string,
  opts?: {
    status?: string;
    q?: string;
    model?: string[];
    effort?: string[];
    since?: string;
    page?: number;
    page_size?: number;
  },
): Promise<PaginatedBatchRunSummary> =>
  apiClient("/v1/agent-task-batch-runs", {
    ...NO_CACHE,
    query: {
      project,
      status: opts?.status,
      q: opts?.q,
      model: opts?.model?.join(",") || undefined,
      effort: opts?.effort?.join(",") || undefined,
      since: opts?.since,
      page: opts?.page,
      page_size: opts?.page_size,
    },
  });

export const getAgentTaskBatchRun = (
  batchRunId: string,
): Promise<AgentTaskBatchRunDetail> =>
  apiClient(`/v1/agent-task-batch-runs/${encodeURIComponent(batchRunId)}`, NO_CACHE);

export const getAgentTaskRun = (
  taskRunId: string,
): Promise<AgentTaskRunDetail> =>
  apiClient(`/v1/agent-task-runs/${encodeURIComponent(taskRunId)}`, NO_CACHE);

/** Issue #159: a run's judgments — original first, rejudges newest first. */
export const listAgentTaskRunJudgments = (
  taskRunId: string,
): Promise<AgentTaskJudgmentsResponse> =>
  apiClient(`/v1/agent-task-runs/${encodeURIComponent(taskRunId)}/judgments`, NO_CACHE);

export function listTaskFiles(
  taskId: string,
  projectId: string,
  commitSha?: string | null,
): Promise<TaskFileListResponse> {
  return apiClient(
    `/v1/projects/${encodeURIComponent(projectId)}/agent-tasks/${encodeURIComponent(taskId)}/files`,
    { ...NO_CACHE, query: { commit_sha: commitSha } },
  );
}

export function readTaskFile(
  taskId: string,
  filePath: string,
  projectId: string,
  commitSha?: string | null,
  signal?: AbortSignal,
): Promise<TaskFileContentResponse> {
  return apiClient(
    `/v1/projects/${encodeURIComponent(projectId)}/agent-tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(filePath)}`,
    { ...NO_CACHE, query: { commit_sha: commitSha }, signal },
  );
}

export const listAgentTaskSchedules = (
  project?: string,
): Promise<AgentTaskScheduleSummary[]> =>
  apiClient("/v1/agent-task-schedules", {
    ...NO_CACHE,
    query: { project },
  });

export const getAgentTaskSchedule = (
  scheduleId: string,
): Promise<AgentTaskScheduleDetail> =>
  apiClient(`/v1/agent-task-schedules/${encodeURIComponent(scheduleId)}`, NO_CACHE);

export const createAgentTaskSchedule = (
  request: CreateAgentTaskScheduleRequest,
): Promise<AgentTaskScheduleDetail> =>
  apiClient("/v1/agent-task-schedules", { method: "POST", body: request });

export const updateAgentTaskSchedule = (
  scheduleId: string,
  request: UpdateAgentTaskScheduleRequest,
): Promise<AgentTaskScheduleDetail> =>
  apiClient(`/v1/agent-task-schedules/${encodeURIComponent(scheduleId)}`, {
    method: "PATCH",
    body: request,
  });

export const deleteAgentTaskSchedule = (
  scheduleId: string,
): Promise<void> =>
  apiClient(`/v1/agent-task-schedules/${encodeURIComponent(scheduleId)}`, {
    method: "DELETE",
  });

export const triggerSchedule = (
  scheduleId: string,
): Promise<TriggerScheduleResponse> =>
  apiClient(
    `/v1/agent-task-schedules/${encodeURIComponent(scheduleId)}/trigger`,
    { method: "POST" },
  );

/** bounded newest-first Occurrence history (membership-scoped). */
export const listScheduleOccurrences = (
  scheduleId: string,
  limit = 20,
): Promise<{ occurrences: ScheduleOccurrenceSummary[] }> =>
  apiClient(
    `/v1/agent-task-schedules/${encodeURIComponent(scheduleId)}/occurrences`,
    { ...NO_CACHE, query: { limit } },
  );

export const getAdaptiveStates = (
  scheduleId: string,
): Promise<AdaptiveTaskState[]> =>
  apiClient(
    `/v1/agent-task-schedules/${encodeURIComponent(scheduleId)}/adaptive-states`,
    NO_CACHE,
  );

/** Read the pinned Task Definition source for CodeMirror display.
 * Run-bound: authorization resolves from task_run_id → batch.project. */
export function readTaskDefinitionSource(
  taskRunId: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<TaskFileContentResponse> {
  return apiClient("/v1/task-definition-source", {
    ...NO_CACHE,
    query: { task_run_id: taskRunId, file_path: filePath },
    signal,
  });
}

/** idempotently cancel a Batch's Attempts. Reused by source-owned
 * and legacy Pool Runs. Returns the number of Attempts touched. */
export const cancelAgentTaskBatchRun = (
  batchRunId: string,
): Promise<{ ok: true; cancelled: number }> =>
  apiClient(
    `/v1/agent-task-batch-runs/${encodeURIComponent(batchRunId)}/cancel`,
    { method: "POST", body: {} },
  );

export interface RunDeletionCounts {
  ok: true;
  deleted_runs: number;
  deleted_traces: number;
  deleted_calls: number;
  deleted_batches: number;
}

/** Permanently delete one Task Run: its Check Report, judgments,
 * corrections, Deliverables (rows and stored objects), attempt, and trace.
 * Terminal/cancelled runs only; the parent Batch's rollups are recomputed
 * and an emptied Batch is removed. Project admin only. */
export const deleteAgentTaskRun = (
  taskRunId: string,
): Promise<RunDeletionCounts> =>
  apiClient(`/v1/agent-task-runs/${encodeURIComponent(taskRunId)}`, {
    method: "DELETE",
  });

/** Permanently delete a Batch Run and every Task Run it owns (checks,
 * judgments, corrections, Deliverables, attempts, traces) plus the Batch's
 * Task Revision bundles. Terminal batches only. Project admin only. */
export const deleteAgentTaskBatchRun = (
  batchRunId: string,
): Promise<RunDeletionCounts> =>
  apiClient(`/v1/agent-task-batch-runs/${encodeURIComponent(batchRunId)}`, {
    method: "DELETE",
  });

/** Correct one recorded top-level test result on a Run.
 * `action` sets the effective PASS/FAIL or clears back to the recorded
 * result. Evidence is never rewritten; the response carries the effective
 * Test + Run projection. */
export function correctTestResult(
  taskRunId: string,
  body: { test_id: string; action: "set_pass" | "set_fail" | "clear"; reason?: string },
): Promise<CorrectedTestResult> {
  return apiClient(
    `/v1/agent-task-runs/${encodeURIComponent(taskRunId)}/test-result-corrections`,
    { method: "POST", body },
  );
}
