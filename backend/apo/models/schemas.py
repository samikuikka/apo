from datetime import datetime
from typing import Literal

from sqlalchemy import Column
from pydantic import Field as PDField
from sqlmodel import JSON, Field, SQLModel
from sqlmodel._compat import SQLModelConfig

type JsonMap = dict[str, object]
type MessageList = list[JsonMap]


# ============================================================================
# Runs & Run Metrics
# ============================================================================


class Run(SQLModel):
    """Run model for API responses."""

    id: str
    project: str
    task_id: str | None = None
    flow_name: str | None = None
    version: str | None = None
    user_id: str | None = None

    # === NEW: Langfuse-style observability fields ===
    session_id: str | None = None
    environment: str = "default"
    external_id: str | None = None
    tags: list[str] = []
    run_metadata: JsonMap | None = (
        None  # Renamed from 'metadata' to avoid reserved word conflicts
    )
    primary_model: str | None = None

    input: dict[str, object] | list[object] | str | None = None
    output: dict[str, object] | list[object] | str | None = None

    bookmarked: bool = False
    is_public: bool = False

    task_run_id: str | None = None

    created_at: datetime
    completed_at: datetime | None = None
    duration_ms: float | None = None
    call_count: int


class RunMetric(SQLModel):
    """Metric at run level."""

    metric_name: str
    metric_type: str  # "quality" | "aggregate"
    # Score value support for multiple data types
    score: float | None = None
    string_value: str | None = None
    data_type: str = "NUMERIC"  # NUMERIC, CATEGORICAL, BOOLEAN
    # Langfuse-inspired: Track where the score came from
    source: str = "API"  # ANNOTATION, API, EVAL
    config_id: int | None = None
    reasoning: str | None = None
    meta: JsonMap | None = None
    created_at: datetime


class RunDetail(SQLModel):
    """Run with all metrics and calls."""

    run: Run
    metrics: list[RunMetric]
    calls: list["LoggedCall"]


class FacetBucket(SQLModel):
    value: str
    count: int


class RunFacets(SQLModel):
    status: list[FacetBucket] = []
    models: list[FacetBucket] = []
    environments: list[FacetBucket] = []
    tags: list[FacetBucket] = []
    users: list[FacetBucket] = []
    sessions: list[FacetBucket] = []
    scores: list[FacetBucket] = []


class SessionSummary(SQLModel):
    session_id: str
    trace_count: int
    first_trace_at: str
    last_trace_at: str
    total_cost: float = 0
    total_tokens: int = 0


class PaginatedSessionSummary(SQLModel):
    data: list[SessionSummary] = []
    total_count: int = 0
    page: int = 0
    page_size: int = 20
    total_pages: int = 0


class RunSummary(SQLModel):
    """Aggregated run info for list view."""

    id: str
    project: str
    flow_name: str | None = None
    task_id: str | None = None
    version: str | None = None

    # === NEW: Langfuse-style observability fields ===
    session_id: str | None = None
    environment: str = "default"
    tags: list[str] = []
    user_id: str | None = None
    primary_model: str | None = None

    bookmarked: bool = False

    task_run_id: str | None = None

    call_count: int
    duration_ms: float | None = None
    created_at: datetime
    completed_at: datetime | None = None

    # Run-level status from call levels
    status: str = "success"  # "success" | "warning" | "error"
    error_count: int = 0
    warning_count: int = 0

    # Per-metric summaries (flattened for display)
    metrics: list[RunMetric] = Field(default_factory=list)

    # I/O previews (truncated first-call input/output)
    input_preview: str | None = None
    output_preview: str | None = None


class CreateRunRequest(SQLModel):
    """Request to create a new run."""

    project: str
    task_id: str | None = None
    flow_name: str | None = None
    version: str | None = None
    user_id: str | None = None

    # === NEW: Langfuse-style observability fields ===
    session_id: str | None = None
    environment: str = "default"
    external_id: str | None = None
    tags: list[str] = []
    run_metadata: JsonMap | None = None
    primary_model: str | None = None  # TASK-015: Primary model used


class UpdateRunRequest(SQLModel):
    """Request to update a run."""

    completed: bool | None = None
    call_count: int | None = None


# ============================================================================
# Telemetry / Logged Calls
# ============================================================================


class LoggedCallBase(SQLModel):
    # SPEC-133 M4: id is the OTel span ID (not the PK). Surrogate row_id is the PK.
    id: str = Field(index=True)
    project: str = Field(index=True)
    task_id: str = Field(index=True)
    run_id: str | None = Field(default=None, index=True)
    flow_name: str | None = Field(default=None, index=True)
    step_name: str | None = Field(default=None)
    step_index: int | None = Field(default=None)
    version: str | None = Field(default=None, index=True)
    created_at: datetime = Field(index=True)
    model: str
    latency_ms: float | None = Field(default=None, index=True)
    cost: int | None = Field(default=None, index=True)  # micro-USD int (SPEC-136 ticket 06)

    # === Langfuse-style observability fields ===
    parent_call_id: str | None = Field(
        default=None, index=True
    )  # For hierarchical spans
    observation_type: str = Field(
        default="GENERATION"
    )  # SPAN, GENERATION, TOOL, CHAIN, RETRIEVER, EVALUATOR, EMBEDDING, GUARDRAIL
    level: str = Field(default="DEFAULT")  # DEBUG, DEFAULT, WARNING, ERROR
    status_message: str | None = Field(default=None)  # Error messages or status
    completion_start_time: datetime | None = Field(
        default=None
    )  # When LLM processing started
    end_time: datetime | None = Field(default=None)  # Explicit end time
    prompt_tokens: int | None = Field(default=None)  # Input token count
    completion_tokens: int | None = Field(default=None)  # Output token count

    # === NEW: Session and context fields ===
    session_id: str | None = Field(default=None, index=True)  # Link to session
    environment: str = Field(default="default")  # Environment name
    tags: list[str] = Field(
        default_factory=list, sa_column=Column("tags", JSON)
    )  # Tags for categorization

    # === NEW: Langfuse-inspired enhancements ===

    # Computed token total (prompt_tokens + completion_tokens)
    total_tokens: int | None = Field(default=None)

    # Prompt metadata preserved for legacy tracing integrations
    prompt_id: str | None = Field(default=None, index=True)  # Legacy prompt identifier
    prompt_version: int | None = Field(default=None)  # Legacy prompt version metadata

    # Cost (SPEC-136 ticket 06). Effective total in micro-USD int. Provided by
    # the SDK (verbatim) or computed from the frozen breakdown (sum of dims).
    provided_cost: int | None = Field(default=None)  # micro-USD int; SDK-reported

    # Per-call cost storage (SPEC-136 ticket 06): the frozen per-dimension
    # breakdown, normalized raw usage, the matched model/tier, and provenance.
    cost_breakdown: dict[str, int] | None = None  # JSON: {UsageKey: micro-USD}
    raw_usage: dict[str, int] | None = None  # JSON: normalized usage map
    matched_tier_id: int | None = Field(default=None)
    matched_tier_name: str | None = Field(default=None)
    cost_provenance: str | None = Field(default=None)  # "provided" | "computed"

    # Time to first token metric (completion_start_time - created_at)
    time_to_first_token_ms: float | None = Field(default=None)

    # Model tracking (user-provided vs internal). internal_model_id is now the
    # FK to the matched models row (SPEC-136 ticket 06).
    provided_model_name: str | None = Field(default=None)  # What user specified
    internal_model_id: int | None = Field(
        default=None
    )  # FK to models.id for the matched pricing row

    # Tool-specific fields (when observation_type = "TOOL")
    tool_name: str | None = Field(default=None)  # Name of the tool/function
    tool_parameters: JsonMap | None = Field(
        default=None, sa_column=Column("tool_parameters", JSON)
    )  # Tool input
    tool_result: JsonMap | None = Field(
        default=None, sa_column=Column("tool_result", JSON)
    )  # Tool output

    corrected_output: str | None = Field(default=None)

    input: JsonMap = Field(sa_column=Column(JSON))
    messages: MessageList = Field(sa_column=Column(JSON))
    output: JsonMap = Field(sa_column=Column(JSON))
    user_id: str | None = None


class LoggedCall(LoggedCallBase):
    # Use 'meta' internally for validation (to avoid conflict with SQLAlchemy metadata)
    # but serialize as 'metadata' in JSON responses
    meta: JsonMap | None = PDField(default=None, serialization_alias="metadata")

    model_config: SQLModelConfig = SQLModelConfig(populate_by_name=True)


class CorrectionRequest(SQLModel):
    corrected_output: str | None = None


class IngestionEvent(SQLModel):
    """Single event in a batch ingestion request."""

    id: str
    timestamp: datetime
    type: str  # "run-create", "call-create", "call-update"
    body: JsonMap  # Event-specific data


class BatchIngestionRequest(SQLModel):
    """Batch ingestion request containing multiple events."""

    batch: list[IngestionEvent]


class IngestionError(SQLModel):
    """Error details for a failed event."""

    event_id: str
    error: str


class IngestionResponse(SQLModel):
    """Response from batch ingestion endpoint."""

    processed: int
    errors: list[IngestionError]


# ============================================================================
# Agent Task - Batch Runs & Task Runs
# ============================================================================


class AgentTaskRunStats(SQLModel):
    total_runs: int = 0
    passed_runs: int = 0
    failed_runs: int = 0
    errored_runs: int = 0
    pass_rate: float = 0.0
    avg_duration_ms: float | None = None
    last_run_at: datetime | None = None
    last_run_status: str | None = None
    last_run_passed: bool | None = None
    total_checks: int = 0
    checks_pass_rate: float = 0.0
    avg_cost: float | None = None


class AgentTaskSummary(SQLModel):
    id: str
    task_path: str
    folder_path: str
    display_name: str
    adapter_name: str
    has_checks: bool
    has_user_simulator: bool
    tags: list[str] = Field(default_factory=list)
    run_stats: AgentTaskRunStats | None = None


class AgentTaskDetail(SQLModel):
    id: str
    task_path: str
    folder_path: str
    display_name: str
    adapter_name: str
    has_checks: bool
    has_user_simulator: bool
    tags: list[str] = Field(default_factory=list)
    latest_run: "AgentTaskRunSummary | None" = None
    run_stats: AgentTaskRunStats | None = None


class AgentTaskRunTrigger(SQLModel):
    source: str | None = None
    actor: str | None = None
    hostname: str | None = None
    user_agent: str | None = None
    entrypoint: str | None = None
    initiated_at: datetime | None = None
    ci_system: str | None = None
    ci_run_id: str | None = None
    ci_run_url: str | None = None
    repository: str | None = None
    branch: str | None = None
    commit_sha: str | None = None
    pr_number: str | None = None
    schedule_id: str | None = None
    schedule_name: str | None = None


class FailureBreakdownItem(SQLModel):
    """A single failure category's contribution to a batch's outcome."""

    category: str
    label: str
    count: int


class AgentTaskRunSummary(SQLModel):
    id: str
    batch_run_id: str
    task_id: str
    task_path: str
    adapter_name: str | None = None
    status: str
    pass_result: bool | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    trace_run_id: str | None = None
    # Primary model used by the run's trace (denormalized from RunDB via
    # the trace_run_id link). Populated by the projection layer; absent
    # for runs whose trace has not been persisted.
    primary_model: str | None = None
    task_source_commit_sha: str | None = None
    error_message: str | None = None
    trace_persistence_status: str = "pending"
    trace_error_message: str | None = None
    total_cost: float | None = None
    total_checks: int = 0
    passed_checks: int = 0
    failed_checks: int = 0
    trigger: AgentTaskRunTrigger | None = None
    error_category: str | None = None


class AgentTaskRunDetail(SQLModel):
    id: str
    batch_run_id: str
    task_id: str
    task_path: str
    adapter_name: str | None = None
    status: str
    pass_result: bool | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    trace_run_id: str | None = None
    primary_model: str | None = None
    task_source_commit_sha: str | None = None
    error_message: str | None = None
    trace_persistence_status: str = "pending"
    trace_error_message: str | None = None
    total_cost: float | None = None
    total_tokens: int | None = None
    total_checks: int = 0
    passed_checks: int = 0
    failed_checks: int = 0
    trigger: AgentTaskRunTrigger | None = None
    checks_json: list[dict[str, object]] | None = None
    transcript_json: dict[str, object] | None = None
    deliverables_json: dict[str, object] | None = None
    error_category: str | None = None


class AgentTaskBatchRunSummary(SQLModel):
    id: str
    project: str
    selection_type: str
    selection_query: dict[str, object] | None = None
    task_root: str | None = None
    grep: str | None = None
    environment: str = "default"
    status: str
    total_tasks: int = 0
    passed_tasks: int = 0
    failed_tasks: int = 0
    errored_tasks: int = 0
    total_checks: int = 0
    passed_checks: int = 0
    trace_persistence_status: str = "pending"
    trace_error_message: str | None = None
    total_cost: float | None = None
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    trigger: AgentTaskRunTrigger | None = None


class AgentTaskBatchRunDetail(SQLModel):
    id: str
    project: str
    selection_type: str
    selection_query: dict[str, object] | None = None
    task_root: str | None = None
    grep: str | None = None
    environment: str = "default"
    run_metadata: dict[str, object] | None = None
    status: str
    total_tasks: int = 0
    passed_tasks: int = 0
    failed_tasks: int = 0
    errored_tasks: int = 0
    total_checks: int = 0
    passed_checks: int = 0
    trace_persistence_status: str = "pending"
    trace_error_message: str | None = None
    total_cost: float | None = None
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    trigger: AgentTaskRunTrigger | None = None
    task_runs: list[AgentTaskRunSummary] = Field(default_factory=list)
    failure_breakdown: list[FailureBreakdownItem] = Field(default_factory=list)


class CreateAgentTaskBatchRunRequest(SQLModel):
    project: str
    selection_type: str
    task_paths: list[str] = Field(default_factory=list)
    task_root: str | None = None
    grep: str | None = None
    environment: str = "default"
    run_metadata: dict[str, object] | None = None


class AgentTaskRunExternalSummary(SQLModel):
    """Task run summary for external execution — carries the scoped trace token.

    The token's ``sub`` equals the run id; an external executor (e.g. the CLI
    ``--local`` flag) presents it as ``APO_AUTH_TOKEN`` so ingestion claims
    the trace via the existing SPEC-128/129 path.
    """

    id: str
    task_id: str
    task_path: str
    status: str
    started_at: datetime | None = None
    trace_token: str


class AgentTaskBatchRunExternalDetail(SQLModel):
    """Response for ``POST /v1/agent-task-batch-runs/external``.

    Like ``AgentTaskBatchRunDetail`` but each task run carries a scoped
    ``trace_token`` instead of run-state fields. The backend does NOT execute
    the runs — the caller reports results back via
    ``POST /v1/agent-task-runs/{id}/result``.
    """

    id: str
    project: str
    status: str
    task_runs: list[AgentTaskRunExternalSummary] = Field(default_factory=list)


class ReportAgentTaskRunResultRequest(SQLModel):
    """An external executor's final task-run result report."""

    pass_result: bool
    adapter_name: str | None = None
    trace_run_id: str | None = None
    checks: list[dict[str, object]] = Field(default_factory=list)
    transcript: dict[str, object] = Field(default_factory=dict)
    deliverables: dict[str, object] = Field(default_factory=dict)
    error_message: str | None = None
    # True when the executor threw before producing a result (e.g. an adapter
    # precondition failed). Distinguishes ``status: error`` (the task never
    # produced a verdict) from ``status: failed`` (the judge ran and said no),
    # mirroring the in-process ``except Exception`` path. Issue #13.
    errored: bool = False


# ============================================================================
# Scoring (SPEC-019)
# ============================================================================


class CreateScoreRequest(SQLModel):
    """Request to create a score for a trace or observation."""

    name: str
    value: float | str | bool
    data_type: str = "NUMERIC"
    source: str = "API"
    config_id: int | None = None
    comment: str | None = None


class ScoreResponse(SQLModel):
    """Score response for API."""

    id: int
    trace_id: str | None = None
    observation_id: str | None = None
    name: str
    value: float | str | bool | None = None
    string_value: str | None = None
    data_type: str = "NUMERIC"
    source: str = "API"
    config_id: int | None = None
    comment: str | None = None
    created_at: datetime


class BulkScoreRequest(SQLModel):
    """Request to create multiple scores at once."""

    scores: list[CreateScoreRequest]
    trace_id: str | None = None
    observation_id: str | None = None


class BulkScoreResponse(SQLModel):
    """Response from bulk score creation."""

    created: int
    errors: list[str] = Field(default_factory=list)


class ScoreConfigResponse(SQLModel):
    """Score config response for API."""

    id: int
    name: str
    data_type: str = "NUMERIC"
    min_value: float | None = None
    max_value: float | None = None
    categories: dict[str, object] | None = None
    description: str | None = None
    is_archived: bool = False


# ============================================================================
# Annotation Queues (SPEC-019)
# ============================================================================


class CreateAnnotationQueueRequest(SQLModel):
    """Request to create an annotation queue."""

    project: str
    name: str
    target_type: str = "TRACE"
    score_config_id: int | None = None


class AnnotationQueueResponse(SQLModel):
    """Annotation queue response."""

    id: int
    project: str
    name: str
    target_type: str
    score_config_id: int | None = None
    total_items: int = 0
    completed_items: int = 0
    is_active: bool = True
    created_at: datetime
    updated_at: datetime


class CompleteAnnotationRequest(SQLModel):
    """Request to complete an annotation with a score."""

    score_value: float | str | bool
    comment: str | None = None


# ============================================================================
# Agent Task Schedules
# ============================================================================


class ScheduleLastBatchSummary(SQLModel):
    id: str
    status: str
    total_tasks: int = 0
    passed_tasks: int = 0
    failed_tasks: int = 0
    errored_tasks: int = 0
    created_at: datetime
    completed_at: datetime | None = None
    failure_breakdown: list[FailureBreakdownItem] = Field(default_factory=list)


class AgentTaskScheduleSummary(SQLModel):
    id: str
    project: str
    name: str
    selection_type: str
    selection_query: dict[str, object] | None = None
    task_root: str | None = None
    grep: str | None = None
    environment: str = "default"
    cadence_type: str
    timezone: str = "UTC"
    hour: int = 9
    minute: int = 0
    day_of_week: int | None = None
    day_of_month: int | None = None
    min_interval_days: float = 1.0
    max_interval_days: float = 30.0
    enabled: bool = True
    last_triggered_at: datetime | None = None
    last_batch_run_id: str | None = None
    next_run_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    last_batch: ScheduleLastBatchSummary | None = None
    consecutive_failures: int = 0


class AgentTaskScheduleDetail(AgentTaskScheduleSummary):
    run_metadata: dict[str, object] | None = None


class AdaptiveTaskStateSummary(SQLModel):
    """Per-task adaptive scheduling state for display."""

    task_id: str
    task_path: str = ""
    current_interval_days: float
    ease_factor: float
    consecutive_passes: int
    last_run_at: datetime | None = None
    last_status: str | None = None
    next_run_at: datetime | None = None


class CreateAgentTaskScheduleRequest(SQLModel):
    project: str
    name: str
    selection_type: str = "tasks"
    task_paths: list[str] = Field(default_factory=list)
    task_root: str | None = None
    grep: str | None = None
    environment: str = "default"
    cadence_type: str = "daily"
    timezone: str = "UTC"
    hour: int = 9
    minute: int = 0
    day_of_week: int | None = None
    day_of_month: int | None = None
    min_interval_days: float = 1.0
    max_interval_days: float = 30.0
    enabled: bool = True
    run_metadata: dict[str, object] | None = None


class UpdateAgentTaskScheduleRequest(SQLModel):
    name: str | None = None
    task_paths: list[str] | None = None
    task_root: str | None = None
    grep: str | None = None
    environment: str | None = None
    cadence_type: str | None = None
    timezone: str | None = None
    hour: int | None = None
    minute: int | None = None
    day_of_week: int | None = None
    day_of_month: int | None = None
    min_interval_days: float | None = None
    max_interval_days: float | None = None
    enabled: bool | None = None
    run_metadata: dict[str, object] | None = None


class ApiKeyCreate(SQLModel):
    name: str = "Default"
    project: str = "example-service"
    scope: str = "full"
    expires_at: str | None = None


class ApiKeyBootstrapRequest(SQLModel):
    """Email+password credentials used to mint an API key for first-run CLI login."""

    email: str
    password: str
    name: str = "apo-cli"
    project: str = "example-service"
    scope: str = "full"


class ApiKeyResponse(SQLModel):
    id: str
    name: str
    prefix: str
    project: str
    created_by: str
    scope: str = "full"
    created_at: str
    last_used_at: str | None
    expires_at: str | None
    # SPEC-092: Two-key model fields
    public_key: str | None = None
    display_secret_key: str | None = None


class ApiKeyCreateResponse(ApiKeyResponse):
    """Response for key creation. Includes the full key for legacy keys,
    or public_key + secret_key for two-key model keys."""
    key: str | None = None
    # SPEC-092: Two-key model — secret_key shown once at creation
    secret_key: str | None = None


class ApiKeyRotateResponse(SQLModel):
    id: str
    key: str | None = None
    message: str
    # SPEC-092: Two-key model fields
    public_key: str | None = None
    secret_key: str | None = None


class UserResponse(SQLModel):
    id: str
    email: str
    name: str
    is_admin: bool
    is_active: bool
    created_at: str


class ListUsersResponse(SQLModel):
    users: list[UserResponse]


class InviteUserRequest(SQLModel):
    email: str
    name: str
    password: str


class UpdateUserRequest(SQLModel):
    name: str | None = None
    is_admin: bool | None = None
    is_active: bool | None = None


# ============================================================================
# Projects & Project Task Sources (SPEC-118)
# ============================================================================


class ProjectSummary(SQLModel):
    """Project as returned by list/create endpoints."""

    id: str
    name: str
    trace_content_policy: Literal["off", "redacted", "full"] = "full"
    created_by: str | None = None
    created_at: datetime | None = None
    current_user_role: str | None = None  # "owner" | "admin" | "member"


class UpdateProjectRequest(SQLModel):
    """Mutable Project settings. Trace content defaults to ``full``; switch to
    ``redacted`` for production deployments handling sensitive data."""

    name: str | None = None
    trace_content_policy: Literal["off", "redacted", "full"] | None = None


class ProjectBootstrapRequest(SQLModel):
    """Email+password credentials used to create the first project on a fresh
    instance and mint an API key scoped to it in a single call.

    Solves the chicken-and-egg of ``apo login`` (which needs a project to scope
    a key to) vs ``POST /v1/projects`` (which needs an authenticated key).
    Unlike ``ApiKeyBootstrapRequest``, this endpoint mints the project itself,
    so it never leans on the legacy-project tolerance in
    ``require_project_role_or_legacy`` — a real ``ProjectDB`` row exists before
    the key is created.
    """

    email: str
    password: str
    name: str
    trace_content_policy: Literal["off", "redacted", "full"] = "redacted"
    key_name: str = "apo-cli"
    scope: Literal["full", "ingest"] = "full"


class ProjectTaskSource(SQLModel):
    """Serialized task source configuration for a project."""

    project: str
    source_type: str  # "git" | "filesystem" | "demo"
    display_name: str
    repository_url: str | None = None
    git_ref: str | None = None
    subpath: str | None = None
    filesystem_path: str | None = None
    demo_seed_id: str | None = None
    status: str  # "unconfigured" | "pending_sync" | "ready" | "error"
    last_synced_at: datetime | None = None
    last_resolved_commit_sha: str | None = None
    last_error: str | None = None
    inventory_stale: bool = False


class ProjectDetail(ProjectSummary):
    """Project payload that also carries its task source, if configured.

    ``task_source`` is ``None`` for fresh projects that have not yet been
    wired up to a Git/filesystem/demo source. Project-scoped dashboard
    pages branch on this to decide between setup UI and normal data.
    """

    permissions: "ProjectPermissionSummary | None" = None
    task_source: ProjectTaskSource | None = None


class ProjectPermissionSummary(SQLModel):
    """Computed permissions for the current user on a project (SPEC-122).

    ``role`` is ``None`` for the demo project, which has no memberships
    but remains world-readable. The boolean flags are derived from the
    role so route guards and UI surfaces can branch on a single value.
    """

    role: str | None = None  # "owner" | "admin" | "member"
    can_manage_project: bool = False
    can_manage_members: bool = False
    can_run_tasks: bool = False
    can_edit_scores: bool = False


class ProjectMemberSummary(SQLModel):
    """A single project membership row serialized for the API."""

    user_id: str
    email: str
    name: str
    role: str  # "owner" | "admin" | "member"
    is_active: bool
    joined_at: datetime | None = None


class AddProjectMemberRequest(SQLModel):
    """Body of ``POST /v1/projects/{id}/members``."""

    email: str
    role: str = "member"  # "admin" | "member"


class UpdateProjectMemberRequest(SQLModel):
    """Body of ``PATCH /v1/projects/{id}/members/{user_id}``."""

    role: str | None = None  # "owner" | "admin" | "member"


# ---------------------------------------------------------------------------
# Project invitations (SPEC-127)
# ---------------------------------------------------------------------------


class CreateProjectInvitationRequest(SQLModel):
    """Body of ``POST /v1/projects/{id}/invitations``."""

    email: str
    role: str = "member"  # "admin" | "member" by default; "owner" owner-only


class ProjectInvitationSummary(SQLModel):
    """Public summary of a pending project invitation."""

    id: str
    email: str
    role: str
    delivery_method: str
    created_at: datetime
    expires_at: datetime
    invited_by_user_id: str
    invited_by_name: str | None = None
    can_resend: bool = False
    can_revoke: bool = False


class CreateProjectInvitationResponse(SQLModel):
    """Response from create/resend invitation endpoints.

    ``invite_url`` is only populated when the inviter is authorized to
    see the raw token (typically when email delivery is unavailable and
    the URL must be shared out-of-band).
    """

    invitation: ProjectInvitationSummary
    invite_url: str | None = None
    delivery_status: str  # "sent" | "link_only"


class InvitationTokenPreviewResponse(SQLModel):
    """Public preview of an invitation token (no auth required).

    Only fields that are safe to reveal before sign-in are populated.
    Invalid/expired/revoked tokens return ``valid=False`` with a generic
    ``reason`` and no project/email metadata.
    """

    valid: bool = False
    reason: str | None = None
    email: str | None = None
    project_id: str | None = None
    project_name: str | None = None
    role: str | None = None
    requires_login: bool = False
    requires_account_creation: bool = False


class AcceptInvitationCreateAccountRequest(SQLModel):
    """Body of ``POST /auth/invitations/accept/create-account``."""

    token: str
    name: str
    password: str


class AcceptInvitationExistingAccountRequest(SQLModel):
    """Body of ``POST /auth/invitations/accept/existing-account``."""

    token: str


class UpdateProjectTaskSourceRequest(SQLModel):
    """Request body for ``PATCH /v1/projects/{id}/task-source``."""

    source_type: str  # "git" | "filesystem" | "demo"
    display_name: str | None = None
    repository_url: str | None = None
    git_ref: str | None = None
    subpath: str | None = None
    filesystem_path: str | None = None
    demo_seed_id: str | None = None
