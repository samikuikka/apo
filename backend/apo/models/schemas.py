# pyright: reportUnannotatedClassAttribute=false

from datetime import datetime
from typing import Literal, cast, get_args

from sqlalchemy import Column
from pydantic import Field as PDField
from sqlmodel import JSON, Field, SQLModel
from sqlmodel._compat import SQLModelConfig

from .execution import (
    AttemptSummary,
    ExecutionTarget,
    TaskRevisionSummary,
)

type JsonMap = dict[str, object]
type MessageList = list[JsonMap]

# Arbitrary JSON value: what a free-form observation field (tool_result, input,
# output, ...) can hold. DB columns are JSON and accept any of these, so the
# read model must too — otherwise a string/number/list value written via the
# trace-projection path 500s on read. See issue #23.
type JsonValue = str | int | float | bool | list[object] | dict[str, object]


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
    run_metadata: JsonValue | None = (
        None  # Renamed from 'metadata' to avoid reserved word conflicts
    )
    primary_model: str | None = None

    input: JsonValue | None = None
    output: JsonValue | None = None

    bookmarked: bool = False

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
    total_cost: float = 0  # micro-USD, summed over the session's calls
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
    service_name: str | None = None

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
    # id is the OTel span ID (not the PK). Surrogate row_id is the PK.
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
    cost: int | None = Field(default=None, index=True)  # micro-USD int

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

    # Cost. Effective total in micro-USD int. Provided by
    # the SDK (verbatim) or computed from the frozen breakdown (sum of dims).
    provided_cost: int | None = Field(default=None)  # micro-USD int; SDK-reported

    # Per-call cost storage: the frozen per-dimension
    # breakdown, normalized raw usage, the matched model/tier, and provenance.
    cost_breakdown: dict[str, int] | None = None  # JSON: {UsageKey: micro-USD}
    raw_usage: dict[str, int] | None = None  # JSON: normalized usage map
    matched_tier_id: int | None = Field(default=None)
    matched_tier_name: str | None = Field(default=None)
    cost_provenance: str | None = Field(default=None)  # "provided" | "computed"

    # Time to first token metric (completion_start_time - created_at)
    time_to_first_token_ms: float | None = Field(default=None)

    # Model tracking (user-provided vs internal). internal_model_id is now the
    # FK to the matched models row.
    provided_model_name: str | None = Field(default=None)  # What user specified
    internal_model_id: int | None = Field(
        default=None
    )  # FK to models.id for the matched pricing row

    # Tool-specific fields (when observation_type = "TOOL")
    tool_name: str | None = Field(default=None)  # Name of the tool/function
    tool_parameters: JsonValue | None = Field(
        default=None, sa_column=Column("tool_parameters", JSON)
    )  # Tool input
    tool_result: JsonValue | None = Field(
        default=None, sa_column=Column("tool_result", JSON)
    )  # Tool output

    corrected_output: str | None = Field(default=None)

    input: JsonValue = Field(sa_column=Column(JSON))
    messages: MessageList = Field(sa_column=Column(JSON))
    output: JsonValue = Field(sa_column=Column(JSON))
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


class RunConfigEffortFacet(SQLModel):
    """One effort tier and how many runs used it, for a single model."""

    effort: str
    count: int


class RunConfigModelFacet(SQLModel):
    """One model, its total run count, and the per-effort breakdown.

    The Tasks page filter uses this to populate the Model dropdown and, once a
    model is chosen, the model-aware Effort dropdown (only tiers that actually
    ran). ``efforts`` excludes null/unknown efforts — those carry no usable
    filter value.
    """

    model: str
    count: int
    efforts: list[RunConfigEffortFacet] = []
    # Retired from the dropdown by a project member. Every model is returned
    # regardless — the client hides archived ones and offers a "Show archived"
    # reveal, so the toggle needs no refetch.
    archived: bool = False


# — selection-scoped view comparison.

class TaskViewConfig(SQLModel):
    """A model/effort/date filter — one side of a comparison. ``model=None`` = Main."""

    model: str | None = None
    effort: str | None = None
    since: str | None = None  # "5h" | "1d" | "30d" | None (all time)


class TaskViewCreateRequest(SQLModel):
    label: str
    model: str | None = None
    effort: str | None = None
    since: str | None = None


class TaskViewUpdateRequest(SQLModel):
    label: str | None = None
    model: str | None = None
    effort: str | None = None
    since: str | None = None


class TaskViewResponse(SQLModel):
    id: str
    project_id: str
    label: str
    model: str | None = None
    effort: str | None = None
    since: str | None = None


class TaskViewComparisonRequest(SQLModel):
    task_ids: list[str]
    view_a: TaskViewConfig
    view_b: TaskViewConfig


class ResolvedComparisonCell(SQLModel):
    """One task's resolved run on each side, plus the comparison state.

    ``state`` distinguishes *why* a task may not be fully comparable, instead of
    collapsing every non-aligned case into a single bool (which made tasks that
    simply didn't run on one side render as "different eval version"):

      - ``aligned``: both sides ran under the same task-definition revision.
      - ``different_definition``: both sides ran, but under different revisions.
      - ``not_run``: at least one side has no run.
    """

    task_id: str
    a_run_id: str | None
    b_run_id: str | None
    a_status: str | None  # passed | failed | error | None (not run)
    b_status: str | None
    state: Literal["aligned", "different_definition", "not_run"]
    # Frozen effective verdict/count scalars at snapshot creation.
    # Nullable so pre-correction snapshot JSON stays readable; hydrated from
    # the run's effective projection when the comparison is created.
    a_pass_result: bool | None = None
    a_total_checks: int | None = None
    a_passed_checks: int | None = None
    a_corrected_tests: int | None = None
    b_pass_result: bool | None = None
    b_total_checks: int | None = None
    b_passed_checks: int | None = None
    b_corrected_tests: int | None = None


class TaskViewComparisonSnapshot(SQLModel):
    id: str
    project_id: str
    view_a_config: TaskViewConfig
    view_b_config: TaskViewConfig
    task_ids: list[str]
    resolved: list[ResolvedComparisonCell]
    coverage: dict[str, int]  # both_run / aligned / scope
    created_at: datetime
    created_by: str | None = None


class AgentTaskSummary(SQLModel):
    id: str
    task_path: str
    folder_path: str
    display_name: str
    adapter_name: str
    has_checks: bool
    tags: list[str] = Field(default_factory=list)
    run_stats: AgentTaskRunStats | None = None


class AgentTaskDetail(SQLModel):
    id: str
    task_path: str
    folder_path: str
    display_name: str
    adapter_name: str
    has_checks: bool
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


# ============================================================================
# Task Run Deliverables and Artifacts
# ============================================================================


class DeliverableSummary(SQLModel):
    """Manifest projection of a Task Run Deliverable.

    Safe to list without loading any body. ``download_url`` is populated for
    ready rows; pending/failed rows leave it null. Public serialization never
    includes storage keys, backends, or error messages.
    """

    id: str
    name: str
    kind: Literal["json", "artifact"]
    status: Literal["pending", "ready", "failed"]
    media_type: str
    display_filename: str | None = None
    size_bytes: int
    sha256: str
    download_url: str | None = None


class CreateArtifactUploadRequest(SQLModel):
    """Executor request to open an Artifact upload intent."""

    name: str
    display_filename: str
    media_type: str
    size_bytes: int
    sha256: str


class ArtifactUploadIntent(SQLModel):
    """Server response opening a two-phase Artifact upload.

    Clients treat ``upload_url`` as opaque and obey ``method`` plus
    ``required_headers``. Local backends serve an Apo-relative URL; an S3
    backend may later return a presigned URL without changing this model.
    """

    id: str
    deliverable: DeliverableSummary
    method: Literal["PUT"] = "PUT"
    upload_url: str
    required_headers: dict[str, str]
    expires_at: datetime


class AgentTaskDeliverableManifest(SQLModel):
    """Deliverable manifest for one Task Run."""

    task_run_id: str
    items: list[DeliverableSummary]


class TruncatedCheckValue(SQLModel):
    """Marker replacing an oversized ``received`` value in persisted checks.

    Truncation is explicit data, never an ellipsis pretending to be the
    original. ``size_bytes`` and ``sha256`` cover the original full value.
    """

    kind: Literal["truncated"] = "truncated"
    preview: str
    size_bytes: int
    sha256: str


# ============================================================================
# Task Run Configuration
# ============================================================================

# The adapter-reported identity of the agent under test for one Task Run.
# ``model`` is the exact identifier the adapter passed to its runtime after
# resolving env vars, aliases, and defaults. ``effort`` is the exact short
# value that runtime used (e.g. ``low``/``medium``/``high``/``max``).
#
# Omitted ``effort`` means "the adapter did not report effort". Explicit
# ``"default"`` means "the adapter used the runtime's default effort". Effort
# is not a global enum — providers may introduce values apo does not know.
#
# The whole configuration is absent (``None``) when the adapter does not
# support reporting it. Values are descriptive and never affect task
# selection, execution, scoring, retry, or deduplication.
class AgentTaskRunConfiguration(SQLModel):
    """The agent under test's resolved model and effort for one Task Run."""

    model: str
    effort: str | None = None


# Batch Run configuration summary state. Derived from child Task Run
# configurations — never stored on the batch row.
#   - ``unknown``: no child reports a configuration;
#   - ``uniform``: every child reports the same model/effort pair;
#   - ``mixed``:   every child reports a configuration and >1 pair exists;
#   - ``partial``: at least one child reports and at least one does not.
type BatchRunConfigurationState = Literal["uniform", "mixed", "partial", "unknown"]


class AgentTaskRunConfigurationCount(AgentTaskRunConfiguration):
    """A model/effort pair with the number of Task Runs that reported it.

    Counts always preserve pairs together — never a "dominant model" and
    "dominant effort" computed independently, which could invent a
    configuration that never ran.
    """

    task_runs: int


class AgentTaskBatchRunConfigurationSummary(SQLModel):
    """Derived configuration view for a Batch Run's child Task Runs.

    Batch Runs never store or inherit a configuration copy; this summary is
    projected from children on read.
    """

    state: BatchRunConfigurationState
    configurations: list[AgentTaskRunConfigurationCount] = Field(default_factory=list)
    reported_task_runs: int = 0
    total_task_runs: int = 0


class GenerationExecutionSummary(SQLModel):
    """Bounded reliability evidence for a Task Run's model generations."""

    total: int
    errored: int
    error_finish_reasons: dict[str, int] = Field(default_factory=dict)


# Canonical Task Run lifecycle: pending -> running -> passed/failed, or
# error when execution itself failed. "completed" is a *batch* status and
# must never appear on a run — the dashboard renders any status outside
# this set with a raw-label fallback instead of guessing.
TaskRunStatus = Literal["pending", "running", "passed", "failed", "error"]

# Trace persistence outcome for runs and batches (trace_ownership.py).
TracePersistenceStatus = Literal["pending", "persisted", "failed"]

TASK_RUN_STATUSES: frozenset[str] = frozenset(get_args(TaskRunStatus))
TRACE_PERSISTENCE_STATUSES: frozenset[str] = frozenset(
    get_args(TracePersistenceStatus)
)


def as_task_run_status(status: str) -> TaskRunStatus:
    """Narrow a persisted status to the canonical run lifecycle.

    Raises ValueError on drift so a bad value fails loudly at the projection
    boundary instead of silently shipping to clients (where the dashboard
    used to mask it as "pending").
    """
    if status not in TASK_RUN_STATUSES:
        raise ValueError(
            f"non-canonical task run status {status!r}; expected one of {sorted(TASK_RUN_STATUSES)}"
        )
    return cast("TaskRunStatus", status)


def as_trace_persistence_status(status: str) -> TracePersistenceStatus:
    """Narrow a persisted trace persistence status; raises ValueError on drift."""
    if status not in TRACE_PERSISTENCE_STATUSES:
        raise ValueError(
            f"non-canonical trace persistence status {status!r}; expected one of {sorted(TRACE_PERSISTENCE_STATUSES)}"
        )
    return cast("TracePersistenceStatus", status)


class AgentTaskRunSummary(SQLModel):
    id: str
    batch_run_id: str
    task_id: str
    task_path: str
    adapter_name: str | None = None
    status: TaskRunStatus
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
    trace_persistence_status: TracePersistenceStatus = "pending"
    trace_error_message: str | None = None
    total_cost: float | None = None
    # Issue #94: calls whose model had no pricing pattern. Non-zero means
    # ``total_cost`` is a partial sum, not a complete total.
    unpriced_call_count: int = 0
    generation_execution: GenerationExecutionSummary | None = None
    # Total tokens (prompt + completion) across all calls in the run.
    total_tokens: int | None = None
    total_checks: int = 0
    passed_checks: int = 0
    failed_checks: int = 0
    trigger: AgentTaskRunTrigger | None = None
    error_category: str | None = None
    # adapter-reported model/effort for this Task Run. Absent when
    # the adapter does not report configuration. Distinct from the trace's
    # observed ``primary_model``.
    run_configuration: AgentTaskRunConfiguration | None = None
    # Tests whose effective result differs from the recorded one.
    corrected_tests: int = 0


class AgentTaskRunDetail(SQLModel):
    id: str
    batch_run_id: str
    task_id: str
    task_path: str
    adapter_name: str | None = None
    status: TaskRunStatus
    pass_result: bool | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    trace_run_id: str | None = None
    primary_model: str | None = None
    task_source_commit_sha: str | None = None
    error_message: str | None = None
    trace_persistence_status: TracePersistenceStatus = "pending"
    trace_error_message: str | None = None
    total_cost: float | None = None
    # Issue #94: calls whose model had no pricing pattern. Non-zero means
    # ``total_cost`` is a partial sum, not a complete total.
    unpriced_call_count: int = 0
    generation_execution: GenerationExecutionSummary | None = None
    total_tokens: int | None = None
    total_checks: int = 0
    passed_checks: int = 0
    failed_checks: int = 0
    trigger: AgentTaskRunTrigger | None = None
    checks_json: list[dict[str, object]] | None = None
    transcript_json: dict[str, object] | None = None
    deliverables_json: dict[str, object] | None = None
    error_category: str | None = None
    # adapter-reported configuration. Same nested shape as the
    # summary projection.
    run_configuration: AgentTaskRunConfiguration | None = None
    # manifest projection returned with Task Run detail. Safe to
    # render without loading any Deliverable body.
    deliverables: list[DeliverableSummary] = Field(default_factory=list)
    # Task Definition summary for CodeMirror source display.
    task_definition: dict[str, object] | None = None
    # Issue #159: number of recorded rejudge judgments. The original verdict
    # is synthesized on read and not counted.
    judgments_count: int = 0
    # Tests whose effective result differs from the recorded one.
    corrected_tests: int = 0
    # Issue #176: the run's attempt lease heartbeat — the run's live
    # liveness signal. Null when no attempt exists; historical once the
    # run is terminal. Surfaces "no beat for N seconds" on `runs show`
    # instead of leaving `batch show --json` as the only window.
    heartbeat_at: datetime | None = None


class CreateAgentTaskJudgmentRequest(SQLModel):
    """Record a rejudge judgment for a completed Task Run (issue #159).

    ``checks`` is the FULL check set replayed against the Run's stored
    Deliverables — partial re-judging is not expressible here on purpose
    (keeping only the draws you like ratchets an unstable verdict toward
    PASS). Counts and ``pass_result`` are derived server-side from
    ``checks``; ``trigger`` is always ``rejudge``.
    """

    label: str | None = None
    judge_model: str | None = None
    judge_base_url: str | None = None
    task_definition_revision_id: str | None = None
    samples: int = 1
    checks: list[dict[str, object]]
    stability: list[dict[str, object]] | None = None


class AgentTaskJudgmentSummary(SQLModel):
    """One judgment on a Task Run (original or rejudge).

    ``definition_revision_matches_run`` tells readers whether the score was
    produced under the Run's pinned definition revision — False means it was
    scored against a different (explicitly requested) rubric and is not
    comparable to the original verdict.
    """

    id: str
    task_run_id: str
    trigger: str  # "original" | "rejudge"
    label: str | None = None
    judge_model: str | None = None
    judge_base_url: str | None = None
    task_definition_revision_id: str | None = None
    definition_revision_matches_run: bool | None = None
    samples: int = 1
    pass_result: bool | None = None
    total_checks: int = 0
    passed_checks: int = 0
    failed_checks: int = 0
    created_at: datetime | None = None
    # Full check evidence — only on the single-judgment detail endpoint.
    checks: list[dict[str, object]] | None = None
    # Per-check pass counts across samples — detail endpoint only.
    stability: list[dict[str, object]] | None = None


class TaskViewComparisonOverview(SQLModel):
    """Frozen snapshot plus lightweight summaries for all resolved runs."""

    snapshot: TaskViewComparisonSnapshot
    runs: list[AgentTaskRunSummary] = Field(default_factory=list)


# ── Manual test result corrections ──────────────────────────────────

CorrectionAction = Literal["set_pass", "set_fail", "clear"]


class CorrectTestResultRequest(SQLModel):
    test_id: str
    action: CorrectionAction
    reason: str | None = None


class ActiveTestResultCorrection(SQLModel):
    id: str
    action: CorrectionAction
    pass_result: bool
    reason: str
    corrected_by_user_id: str | None
    corrected_by_label: str | None
    corrected_via: Literal["session", "api_key", "open_dev"]
    created_at: datetime


class CorrectedTestResult(SQLModel):
    test_id: str
    recorded_pass: bool
    effective_pass: bool
    correction: ActiveTestResultCorrection | None
    run_status: TaskRunStatus
    run_pass_result: bool
    total_tests: int
    passed_tests: int
    failed_tests: int
    corrected_tests: int


class TaskComparisonEvidence(SQLModel):
    """Detailed evidence for one task in a frozen comparison."""

    task_id: str
    left: AgentTaskRunDetail | None = None
    right: AgentTaskRunDetail | None = None


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
    trace_persistence_status: TracePersistenceStatus = "pending"
    trace_error_message: str | None = None
    total_cost: float | None = None
    # Issue #147: sum of child runs' unpriced calls. Non-zero means
    # ``total_cost`` is a partial sum, not a complete total.
    unpriced_call_count: int = 0
    total_tokens: int | None = None
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    trigger: AgentTaskRunTrigger | None = None
    # derived configuration summary. Projected from child Task
    # Runs on read — never stored on the batch row.
    configuration: AgentTaskBatchRunConfigurationSummary = Field(
        default_factory=lambda: AgentTaskBatchRunConfigurationSummary(
            state="unknown"
        )
    )


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
    cancelled_tasks: int = 0
    total_checks: int = 0
    passed_checks: int = 0
    trace_persistence_status: TracePersistenceStatus = "pending"
    trace_error_message: str | None = None
    total_cost: float | None = None
    # Issue #147: sum of child runs' unpriced calls. Non-zero means
    # ``total_cost`` is a partial sum, not a complete total.
    unpriced_call_count: int = 0
    total_tokens: int | None = None
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    trigger: AgentTaskRunTrigger | None = None
    task_runs: list[AgentTaskRunSummary] = Field(default_factory=list)
    failure_breakdown: list[FailureBreakdownItem] = Field(default_factory=list)
    task_revision: TaskRevisionSummary | None = None
    execution_target: ExecutionTarget | None = None
    executor_pool_name: str | None = None
    attempts: list[AttemptSummary] = Field(default_factory=list)
    # derived configuration summary (uniform/mixed/partial/unknown).
    configuration: AgentTaskBatchRunConfigurationSummary = Field(
        default_factory=lambda: AgentTaskBatchRunConfigurationSummary(
            state="unknown"
        )
    )


class CreateAgentTaskBatchRunRequest(SQLModel):
    model_config = {"extra": "forbid"}
    project: str
    # exact catalog Task IDs. Source-owned by definition — no
    # Pool, path, root, grep, selection_type, or execution_target accepted.
    task_ids: list[str] = Field(default_factory=list)
    environment: str = "default"
    run_metadata: dict[str, object] | None = None


class AgentTaskRunExternalSummary(SQLModel):
    """Task run summary for external execution — carries the scoped trace token.

    The token's ``sub`` equals the run id; an external executor (e.g. the CLI
    ``--local`` flag) presents it as ``APO_AUTH_TOKEN`` so ingestion claims
    the trace via the existing canonical path.
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
    # the adapter's resolved model/effort for this run. Absent for
    # old executors/SDKs. Validated before mutating terminal state.
    run_configuration: AgentTaskRunConfiguration | None = None


# ============================================================================
# Scoring
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
# Annotation Queues
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


#: typed catalog selection stored on a source-owned Schedule's
#: ``selection_query``. ``kind`` discriminates exact IDs, a folder, or all.
ScheduleOccurrenceStatus = Literal["pending", "delivered", "missed", "cancelled"]
OccurrenceMissedReason = Literal[
    "previous_occurrence_active",
    "executor_unavailable",
    "catalog_changed",
    "selection_empty",
]


class ScheduleExecutionOwnerSummary(SQLModel):
    """The fixed User whose Connected Executors run a source-owned Schedule."""

    id: str
    name: str


class ScheduleOccurrenceSummary(SQLModel):
    """One due Schedule time: owns a Batch or is recorded as missed."""

    id: str
    kind: Literal["scheduled", "manual"]
    scheduled_for: datetime
    status: ScheduleOccurrenceStatus
    batch_run_id: str | None = None
    missed_reason: OccurrenceMissedReason | None = None
    resolved_at: datetime | None = None


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
    executor_pool_id: str | None = None
    queue_ttl_seconds: int = 86_400
    disabled_reason: str | None = None
    last_triggered_at: datetime | None = None
    last_batch_run_id: str | None = None
    next_run_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    last_batch: ScheduleLastBatchSummary | None = None
    consecutive_failures: int = 0
    # source-owned scheduled delivery projection.
    execution_kind: Literal["source_owned", "bundled"] = "bundled"
    execution_owner: ScheduleExecutionOwnerSummary | None = None
    connected_environment_state: str | None = None
    active_batch_run_id: str | None = None
    latest_occurrence: ScheduleOccurrenceSummary | None = None
    missed_occurrences: int = 0


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
    model_config = {"extra": "forbid"}
    project: str
    name: str
    selection_type: str = "tasks"
    # typed catalog selection for source-owned schedules. When
    # present, the authenticated admin becomes the fixed Execution Owner and
    # the Schedule is ``source_owned`` (no Pool/path/root/grep accepted).
    selection: dict[str, object] | None = None
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
    executor_pool_id: str | None = None
    queue_ttl_seconds: int = 86_400


class TriggerScheduleResponse(SQLModel):
    """Run Now result: the active Batch (existing or newly created)."""

    batch_run_id: str | None
    occurrence_id: str | None
    created: bool
    schedule: AgentTaskScheduleSummary


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
    executor_pool_id: str | None = None
    queue_ttl_seconds: int | None = None


class ApiKeyCreate(SQLModel):
    """Body of ``POST /v1/api-keys``.

    ``scope`` defaults to ``ingest`` (the least privilege required
    for telemetry submission). Requesting ``full`` remains an explicit
    administrative choice for CLI and management clients.
    """

    name: str = "Default"
    project: str = "example-service"
    scope: Literal["full", "ingest"] = "ingest"
    expires_at: str | None = None
    # Accepted spans/day this key may ingest (NULL/0 = unlimited).
    # Quota is PER KEY — N keys = N x cap.
    daily_span_quota: int | None = None


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
    # Two-key model fields
    public_key: str | None = None
    display_secret_key: str | None = None
    # Guardrails (quota is per key: N keys = N x cap)
    daily_span_quota: int | None = None
    ingest_paused: bool = False
    today_usage: dict[str, object] | None = None


class ApiKeyPatch(SQLModel):
    """Body of ``PATCH /v1/api-keys/{id}`` — ingest guardrail edits."""

    daily_span_quota: int | None = None
    ingest_paused: bool | None = None


class ApiKeyUsageDay(SQLModel):
    """One day of per-key ingest usage."""

    day: str
    span_count: int
    byte_count: int
    request_count: int


class ApiKeyCreateResponse(ApiKeyResponse):
    """Response for key creation. Includes the full key for legacy keys,
    or public_key + secret_key for two-key model keys."""
    key: str | None = None
    # Two-key model — secret_key shown once at creation
    secret_key: str | None = None


class ApiKeyRotateResponse(SQLModel):
    id: str
    key: str | None = None
    message: str
    # Two-key model fields
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
# Projects & Project Task Sources
# ============================================================================


class ProjectSummary(SQLModel):
    """Project as returned by list/create endpoints."""

    id: str
    name: str
    created_by: str | None = None
    created_at: datetime | None = None
    current_user_role: str | None = None  # "owner" | "admin" | "member"
    # Per-project evidence-retention override: NULL = inherit the
    # APO_EVIDENCE_RETENTION_DAYS default, 0 = keep evidence forever.
    evidence_retention_days: int | None = None
    # What the daily maintenance pass actually uses for this project
    # (override if set, else the env default). 0 = evidence never expires.
    effective_evidence_retention_days: int = 0


class UpdateProjectRequest(SQLModel):
    """Mutable Project settings. Trace Content is always stored in full."""

    name: str | None = None
    # Tri-state: absent = leave unchanged (detected via exclude_unset),
    # null = inherit the env default, 0 = keep evidence forever, N = days.
    evidence_retention_days: int | None = None


class ProjectBootstrapRequest(SQLModel):
    """Email+password credentials used to create the first project on a fresh
    instance and mint an API key scoped to it in a single call.

    Solves the chicken-and-egg of ``apo login`` (which needs a project to scope
    a key to) vs ``POST /v1/projects`` (which needs an authenticated key).
    Unlike ``ApiKeyBootstrapRequest``, this endpoint mints the project itself,
    so a real ``ProjectDB`` row exists before the key is created.
    """

    email: str
    password: str
    name: str
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
    """Project payload that also carries its task catalog, if published."""

    permissions: "ProjectPermissionSummary | None" = None
    task_source: "ProjectTaskSource | None" = None
    task_catalog: "TaskCatalog | None" = None


# ============================================================================
# Task Catalog
# ============================================================================


class PublishedTask(SQLModel):
    task_id: str
    display_name: str
    task_path: str
    folder_path: str = ""
    adapter_name: str
    has_checks: bool = False
    tags: list[str] = []


class PublishTaskCatalogRequest(SQLModel):
    schema_version: Literal[1] = 1
    tasks: list[PublishedTask]


class TaskCatalog(SQLModel):
    project: str
    schema_version: Literal[1] = 1
    task_count: int
    catalog_digest: str
    published_at: datetime
    execution_mode: Literal["caller", "bundled_demo"] = "caller"


class ProjectPermissionSummary(SQLModel):
    """Computed permissions for the current user on a project.

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
# Project invitations
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


class CreateHostedAccessInvitationRequest(SQLModel):
    """Body of ``POST /v1/admin/hosted-access-invitations``."""

    email: str


class HostedAccessInvitationSummary(SQLModel):
    """Administrator-facing summary of a hosted access invitation."""

    id: str
    email: str
    delivery_method: str
    expires_at: datetime
    created_at: datetime
    invited_by_user_id: str
    accepted_at: datetime | None = None
    accepted_by_user_id: str | None = None
    accepted_project_id: str | None = None
    revoked_at: datetime | None = None


class CreateHostedAccessInvitationResponse(SQLModel):
    """Response from create/resend admission endpoints.

    ``invite_url`` is populated only when email delivery is unavailable
    (``delivery_status="link_only"``) so the administrator can share the
    URL out-of-band; it is never exposed again afterwards.
    """

    invitation: HostedAccessInvitationSummary
    invite_url: str | None = None
    delivery_status: Literal["sent", "link_only"]


class HostedAccessInvitationPreview(SQLModel):
    """Public preview of an admission token (no auth required).

    Invalid/expired/revoked/accepted tokens return ``valid=False`` with a
    generic reason and no email metadata.
    """

    valid: bool = False
    reason: Literal["invalid", "expired", "revoked", "accepted"] | None = None
    email: str | None = None
    requires_login: bool = False
    requires_account_creation: bool = False


class AcceptHostedAccessCreateAccountRequest(SQLModel):
    """Body of ``POST /auth/hosted-access/accept/create-account``."""

    token: str
    name: str
    password: str
    project_name: str


class AcceptHostedAccessExistingAccountRequest(SQLModel):
    """Body of ``POST /auth/hosted-access/accept/existing-account``."""

    token: str
    project_name: str


class AcceptHostedAccessResponse(SQLModel):
    """Result of a successful admission acceptance: the new Project."""

    status: Literal["accepted"]
    project_id: str


class UpdateProjectTaskSourceRequest(SQLModel):
    """Request body for ``PATCH /v1/projects/{id}/task-source``."""

    source_type: str  # "git" | "filesystem" | "demo"
    display_name: str | None = None
    repository_url: str | None = None
    git_ref: str | None = None
    subpath: str | None = None
    filesystem_path: str | None = None
    demo_seed_id: str | None = None
