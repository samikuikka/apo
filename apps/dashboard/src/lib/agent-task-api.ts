import { apiClient } from "./api-client";

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
  has_user_simulator: boolean;
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

export interface AgentTaskRunSummary {
  id: string;
  batch_run_id: string;
  task_id: string;
  task_path: string;
  adapter_name: string | null;
  status: string;
  pass_result: boolean | null;
  started_at: string | null;
  completed_at: string | null;
  trace_run_id: string | null;
  /** Primary model the run executed under (denormalized from the trace). */
  primary_model: string | null;
  task_source_commit_sha: string | null;
  error_message: string | null;
  total_cost: number | null;
  total_checks: number;
  passed_checks: number;
  failed_checks: number;
  trigger: AgentTaskRunTrigger | null;
  trace_persistence_status: TracePersistenceStatus;
  trace_error_message: string | null;
  error_category: string | null;
}

export type EvaluatorType = "llm" | "code" | "regex";

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
}

export interface AgentTaskRunDetail extends AgentTaskRunSummary {
  total_tokens?: number | null;
  checks_json: CheckResult[] | null;
  transcript_json: Record<string, unknown> | null;
  deliverables_json: Record<string, unknown> | null;
  error_category: string | null;
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
}

export interface AgentTaskBatchRunDetail extends AgentTaskBatchRunSummary {
  run_metadata: Record<string, unknown> | null;
  total_cost: number | null;
  task_runs: AgentTaskRunSummary[];
  failure_breakdown: FailureBreakdownItem[];
}

export interface CreateAgentTaskBatchRunRequest {
  project: string;
  selection_type: string;
  task_paths?: string[];
  task_root?: string | null;
  grep?: string | null;
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
  last_triggered_at: string | null;
  last_batch_run_id: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  last_batch: ScheduleLastBatchSummary | null;
  consecutive_failures: number;
}

export interface AgentTaskScheduleDetail extends AgentTaskScheduleSummary {
  run_metadata: Record<string, unknown> | null;
}

export interface CreateAgentTaskScheduleRequest {
  project: string;
  name: string;
  selection_type?: string;
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

export const listAgentTasks = (
  taskRoot?: string | null,
  grep?: string,
  project?: string,
): Promise<AgentTaskSummary[]> =>
  apiClient("/v1/agent-tasks", {
    ...NO_CACHE,
    query: { task_root: taskRoot, grep, project },
  });

export const getAgentTask = (
  taskId: string,
  taskRoot?: string | null,
  project?: string,
): Promise<AgentTaskDetail> =>
  apiClient(`/v1/agent-tasks/${encodeURIComponent(taskId)}`, {
    ...NO_CACHE,
    query: { task_root: taskRoot, project },
  });

/**
 * SPEC-119: canonical project-scoped task list backed by persisted
 * inventory. Use this in place of `listAgentTasks(taskRoot, ..., project)`
 * whenever the project's task source is configured. Returns an empty
 * array when the source is configured but has no tasks yet (a valid
 * ready state). Throws when the project has no source configured yet
 * (HTTP 404) — callers should branch on the project payload first.
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
 * SPEC-119: canonical project-scoped task detail backed by inventory.
 * Throws HTTP 404 when the task is missing or the project has no source.
 */
export const getProjectAgentTask = (
  projectId: string,
  taskId: string,
): Promise<AgentTaskDetail> =>
  apiClient(
    `/v1/projects/${encodeURIComponent(projectId)}/agent-tasks/${encodeURIComponent(taskId)}`,
    NO_CACHE,
  );

export const listTaskRuns = (
  taskId: string,
  project?: string,
): Promise<AgentTaskRunSummary[]> =>
  apiClient(`/v1/agent-tasks/${encodeURIComponent(taskId)}/runs`, {
    ...NO_CACHE,
    query: { project },
  });

export const createAgentTaskBatchRun = (
  request: CreateAgentTaskBatchRunRequest,
): Promise<AgentTaskBatchRunDetail> =>
  apiClient("/v1/agent-task-batch-runs", { method: "POST", body: request });

export const listAgentTaskBatchRuns = (
  project?: string,
  status?: string,
): Promise<AgentTaskBatchRunSummary[]> =>
  apiClient("/v1/agent-task-batch-runs", {
    ...NO_CACHE,
    query: { project, status },
  });

export const getAgentTaskBatchRun = (
  batchRunId: string,
): Promise<AgentTaskBatchRunDetail> =>
  apiClient(`/v1/agent-task-batch-runs/${encodeURIComponent(batchRunId)}`, NO_CACHE);

export const getAgentTaskRun = (
  taskRunId: string,
): Promise<AgentTaskRunDetail> =>
  apiClient(`/v1/agent-task-runs/${encodeURIComponent(taskRunId)}`, NO_CACHE);

export async function listTaskFiles(
  taskId: string,
  taskRoot?: string | null,
  projectId?: string | null,
  commitSha?: string | null,
): Promise<TaskFileListResponse> {
  if (projectId) {
    return apiClient(
      `/v1/projects/${encodeURIComponent(projectId)}/agent-tasks/${encodeURIComponent(taskId)}/files`,
      { ...NO_CACHE, query: { commit_sha: commitSha } },
    );
  }
  return apiClient(`/v1/agent-tasks/${encodeURIComponent(taskId)}/files`, {
    ...NO_CACHE,
    query: { task_root: taskRoot },
  });
}

export async function readTaskFile(
  taskId: string,
  filePath: string,
  taskRoot?: string | null,
  projectId?: string | null,
  commitSha?: string | null,
  signal?: AbortSignal,
): Promise<TaskFileContentResponse> {
  if (projectId) {
    return apiClient(
      `/v1/projects/${encodeURIComponent(projectId)}/agent-tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(filePath)}`,
      { ...NO_CACHE, query: { commit_sha: commitSha }, signal },
    );
  }
  return apiClient(
    `/v1/agent-tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(filePath)}`,
    { ...NO_CACHE, query: { task_root: taskRoot }, signal },
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
): Promise<{ batch_run_id: string; schedule: AgentTaskScheduleSummary }> =>
  apiClient(
    `/v1/agent-task-schedules/${encodeURIComponent(scheduleId)}/trigger`,
    { method: "POST" },
  );

export const getAdaptiveStates = (
  scheduleId: string,
): Promise<AdaptiveTaskState[]> =>
  apiClient(
    `/v1/agent-task-schedules/${encodeURIComponent(scheduleId)}/adaptive-states`,
    NO_CACHE,
  );
