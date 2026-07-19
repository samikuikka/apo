export type AgentTaskRunStats = {
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
};

export type AgentTaskSummary = {
  id: string;
  task_path: string;
  folder_path: string;
  display_name: string;
  adapter_name: string;
  has_checks: boolean;
  has_user_simulator: boolean;
  tags: string[];
  run_stats: AgentTaskRunStats | null;
};

export type AgentTaskDetail = AgentTaskSummary & {
  latest_run: AgentTaskRunSummary | null;
};

export type AgentTaskRunTrigger = {
  source: string | null;
  actor: string | null;
  hostname: string | null;
  user_agent: string | null;
  entrypoint: string | null;
  initiated_at: string | null;
};

export type AgentTaskRunSummary = {
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
  error_message: string | null;
  total_cost: number | null;
  total_checks: number;
  passed_checks: number;
  failed_checks: number;
  trigger: AgentTaskRunTrigger | null;
};

export type AgentTaskRunDetail = AgentTaskRunSummary & {
  checks_json: CheckResult[] | null;
  transcript_json: Record<string, unknown> | null;
  deliverables_json: Record<string, unknown> | null;
};

/**
 * Source location for a failed check — `file` is a display name (e.g. the
 * checks filename); `line`/`column` are 1-indexed into that file.
 */
export type CheckLocation = {
  file: string;
  line: number;
  column?: number;
};

/**
 * Metadata about an LLM judge call. Populated by evaluators that use an LLM to
 * make their pass/fail decision. All optional so code-only evaluators can omit.
 */
export type CheckJudgeMetadata = {
  model?: string;
  prompt?: { system?: string; user?: string };
  response?: string;
  tokens?: { input: number; output: number };
  cost?: number;
  latency_ms?: number;
  temperature?: number;
};

/**
 * A single assertion within a code check. Carries structured expected/received
 * so the CLI can render testing-framework-style failures (`− Expected` /
 * `+ Received`) instead of a flattened prose string.
 */
export type CheckAssertionResult = {
  id: string;
  pass: boolean;
  reasoning: string;
  expected?: string;
  /** Serialized scalar for code assertions; raw value for LLM judges. */
  received?: unknown;
  location?: CheckLocation;
  evaluator_type?: "llm" | "code";
  judge?: CheckJudgeMetadata;
};

/**
 * Result of evaluating a single check (one entry in `checks_json`). The three
 * required fields (`id`, `pass`, `reasoning`) are always present; the rest is
 * enriched metadata that lets the CLI show *what* failed and *where*.
 */
export type CheckResult = {
  id: string;
  pass: boolean;
  reasoning: string;
  instruction?: string;
  deliverable?: string;
  evaluator_type?: "llm" | "code" | "regex";
  judge?: CheckJudgeMetadata;
  location?: CheckLocation;
  source_file?: string;
  assertions?: CheckAssertionResult[];
};

export type AgentTaskBatchRunSummary = {
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
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  trigger: AgentTaskRunTrigger | null;
};

export type AgentTaskBatchRunDetail = AgentTaskBatchRunSummary & {
  run_metadata: Record<string, unknown> | null;
  task_runs: AgentTaskRunSummary[];
};

export type TaskFileEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size_bytes: number | null;
  extension: string | null;
};

export type TaskFileListResponse = {
  task_id: string;
  task_path: string;
  files: TaskFileEntry[];
};

export type TaskFileContentResponse = {
  name: string;
  path: string;
  content: string;
  size_bytes: number;
  language: string;
  lines: number;
};

export type ProjectTaskSource = {
  project: string;
  source_type: string;
  display_name: string;
  repository_url: string | null;
  git_ref: string | null;
  subpath: string | null;
  filesystem_path: string | null;
  demo_seed_id: string | null;
  status: string;
  last_synced_at: string | null;
  last_resolved_commit_sha: string | null;
  last_error: string | null;
};

export type UpdateProjectTaskSourceRequest = {
  source_type: string;
  display_name?: string | null;
  repository_url?: string | null;
  git_ref?: string | null;
  subpath?: string | null;
  filesystem_path?: string | null;
  demo_seed_id?: string | null;
};

export type GithubAvailability = {
  enabled: boolean;
  client_id: string | null;
};

export type GithubConnection = {
  project: string;
  github_username: string | null;
  github_user_id: string;
  scopes_granted: string | null;
  connected_at: string | null;
};
