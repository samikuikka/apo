# pyright: reportIncompatibleVariableOverride=false

from datetime import datetime, timezone
from typing import ClassVar, final, override
from uuid import uuid4

from sqlalchemy import Column, DateTime, Index, String, TypeDecorator, UniqueConstraint, Text
from sqlalchemy.engine import Dialect
from sqlalchemy.sql import func, text
from sqlmodel import JSON, Field, SQLModel

from ..models.schemas import LoggedCallBase


@final
class UTCDateTime(TypeDecorator[datetime]):
    """Timezone-aware UTC DateTime column.

    SQLite stores tz-aware datetimes as naive strings and drops tzinfo on
    read-back, causing values to serialize without an offset so clients
    mis-parse them as local time. This re-attaches UTC on read; PostgreSQL
    (timestamptz) already returns tz-aware values and passes through unchanged.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    @override
    def process_result_value(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is not None and value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value


# ============================================================================
# Eval Results & Config
# ============================================================================


class ScoreConfigDB(SQLModel, table=True):
    """
    Score configuration schema (Langfuse-inspired).
    Defines the structure and validation rules for metrics.
    Enables type-safe scoring with predefined ranges and categories.
    """

    __tablename__: ClassVar[str] = "score_configs"

    id: int | None = Field(default=None, primary_key=True)
    project: str = Field(index=True)
    name: str = Field(index=True, description="e.g. 'faithfulness', 'answer_relevancy'")
    data_type: str = Field(
        default="NUMERIC", index=True
    )  # NUMERIC, CATEGORICAL, BOOLEAN

    # For NUMERIC scores
    min_value: float | None = Field(
        default=None, description="Minimum valid score (e.g., 0.0)"
    )
    max_value: float | None = Field(
        default=None, description="Maximum valid score (e.g., 1.0)"
    )

    # For CATEGORICAL scores
    categories: dict[str, object] | None = Field(
        default=None,
        sa_column=Column("categories", JSON),
        description="Category definitions: {'correct': 1.0, 'partially_correct': 0.5, 'incorrect': 0.0}",
    )

    description: str | None = Field(
        default=None,
        description="Human-readable description of what this metric measures",
    )
    is_archived: bool = Field(default=False, index=True)

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(
            UTCDateTime, server_default=func.now(), onupdate=func.now()
        ),
    )

    __table_args__: ClassVar[tuple[object, ...]] = (
        UniqueConstraint("project", "name", name="uq_score_config_project_name"),
    )


# ============================================================================
# Sessions
# ============================================================================


class SessionDB(SQLModel, table=True):
    """
    Groups multiple runs for user journey analysis.
    A session represents a user's interaction across multiple workflow executions.
    """

    __tablename__: ClassVar[str] = "sessions"

    id: str = Field(primary_key=True)
    project: str = Field(index=True)
    user_id: str | None = Field(default=None, index=True)
    environment: str = Field(default="default", index=True)

    # Metadata and tags for flexible categorization
    session_metadata: dict[str, object] | None = Field(
        default=None, sa_column=Column("metadata", JSON)
    )
    tags: list[str] = Field(default_factory=list, sa_column=Column("tags", JSON))

    # Timestamps
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    ended_at: datetime | None = Field(default=None)

    # Aggregated stats
    run_count: int = Field(default=0)
    total_cost: float | None = Field(default=None)
    total_tokens: int | None = Field(default=None)


# ============================================================================
# Runs & Run Metrics
# ============================================================================


class RunDB(SQLModel, table=True):
    """
    Represents a single execution of a flow/workflow.
    A run groups multiple logged calls together and stores run-level metrics.

    SPEC-133 M4: ``id`` is the OTel trace ID (not the PK). The PK is a
    surrogate ``row_id`` so two projects can each project the same trace ID.
    """

    __tablename__: ClassVar[str] = "runs"
    __table_args__ = (
        UniqueConstraint("project", "id", name="uq_runs_project_trace"),
    )

    row_id: int | None = Field(default=None, primary_key=True)
    id: str = Field(index=True)  # OTel trace ID
    project: str = Field(index=True)
    task_id: str | None = Field(default=None, index=True)
    flow_name: str | None = Field(default=None, index=True)
    version: str | None = Field(default=None, index=True)

    # User and context
    user_id: str | None = Field(default=None)

    # === NEW: Langfuse-style observability fields ===
    session_id: str | None = Field(
        default=None, index=True
    )  # Group related runs (e.g., multi-turn conversations)
    environment: str = Field(default="default", index=True)  # dev/staging/prod
    external_id: str | None = Field(
        default=None, index=True
    )  # Client-provided ID for idempotency
    tags: list[str] = Field(
        default_factory=list, sa_column=Column("tags", JSON)
    )  # User-defined tags
    run_metadata: dict[str, object] | None = Field(
        default=None, sa_column=Column("metadata", JSON)
    )  # Arbitrary metadata (renamed from 'metadata' which is reserved)
    # Trace-level aggregate input/output (Langfuse-style): what started the
    # trace and the final result. Per-call I/O still lives on LoggedCall.
    input: dict[str, object] | list[object] | str | None = Field(
        default=None, sa_column=Column("input", JSON)
    )
    output: dict[str, object] | list[object] | str | None = Field(
        default=None, sa_column=Column("output", JSON)
    )
    primary_model: str | None = Field(
        default=None, index=True
    )  # TASK-015: Primary model used in this run

    bookmarked: bool = Field(default=False, index=True)
    is_public: bool = Field(default=False, index=True)

    # Agent-task link. A task run owns at most one trace.
    task_run_id: str | None = Field(default=None, index=True, unique=True)

    # Timestamps
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    completed_at: datetime | None = Field(default=None)
    duration_ms: float | None = Field(default=None)  # Pre-computed aggregate

    # Call counts
    call_count: int = Field(default=0)


class RunMetricDB(SQLModel, table=True):
    """
    Quality metrics and aggregates at the run level.
    Stores both quality metrics (answer_relevancy, faithfulness) and
    aggregate metrics (total_cost, avg_latency) calculated from call measurements.

    Enhanced with score source tracking (Langfuse-inspired).
    """

    __tablename__: ClassVar[str] = "run_metrics"
    __table_args__ = (
        UniqueConstraint(
            "project", "run_id", "metric_name", "metric_type", name="uq_run_metrics_scope"
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    run_id: str = Field(index=True)  # trace ID, not a FK (surrogate PK migration)
    # SPEC-133 M4: project scope so metrics can be resolved without a join through
    # RunDB, mirroring the projection-table identity (ADR-0002).
    project: str = Field(
        default="default",
        sa_column=Column("project", String, server_default="default", nullable=False, index=True),
    )

    metric_name: str = Field(index=True)
    metric_type: str = Field(index=True)  # "quality" | "aggregate"

    # Score value support for multiple data types
    score: float | None = Field(default=None)  # For NUMERIC and BOOLEAN scores
    string_value: str | None = Field(default=None)  # For CATEGORICAL and BOOLEAN scores
    data_type: str = Field(default="NUMERIC")  # NUMERIC, CATEGORICAL, BOOLEAN

    # Langfuse-inspired: Track where the score came from
    source: str = Field(
        default="API", index=True
    )  # ANNOTATION (human), API (programmatic), EVAL (automated)
    config_id: int | None = Field(
        default=None, foreign_key="score_configs.id", index=True
    )

    reasoning: str | None = None
    meta: dict[str, object] | None = Field(
        default=None, sa_column=Column("metadata", JSON)
    )

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )


class CallMetricDB(SQLModel, table=True):
    """
    Metrics at the call/span level (Langfuse-inspired).
    Allows scoring individual steps within a run (e.g., retrieval quality vs generation quality).
    """

    __tablename__: ClassVar[str] = "call_metrics"
    __table_args__ = (
        UniqueConstraint(
            "project", "call_id", "metric_name", "metric_type", name="uq_call_metrics_scope"
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    call_id: str = Field(index=True)  # span ID, not a FK (surrogate PK migration)
    # SPEC-133 M4: project scope so metrics can be resolved without a join through
    # LoggedCallDB, mirroring the projection-table identity (ADR-0002).
    project: str = Field(
        default="default",
        sa_column=Column("project", String, server_default="default", nullable=False, index=True),
    )

    metric_name: str = Field(index=True)
    metric_type: str = Field(index=True)  # "quality" | "aggregate"

    # Score value support for multiple data types
    score: float | None = Field(default=None)  # For NUMERIC and BOOLEAN scores
    string_value: str | None = Field(default=None)  # For CATEGORICAL and BOOLEAN scores
    data_type: str = Field(default="NUMERIC")  # NUMERIC, CATEGORICAL, BOOLEAN

    # Track where the score came from
    source: str = Field(default="API", index=True)  # ANNOTATION, API, EVAL
    config_id: int | None = Field(
        default=None, foreign_key="score_configs.id", index=True
    )

    reasoning: str | None = None
    meta: dict[str, object] | None = Field(
        default=None, sa_column=Column("metadata", JSON)
    )

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )


# ============================================================================
# Telemetry / Logged Calls
# ============================================================================


class LoggedCallDB(LoggedCallBase, table=True):
    __tablename__: ClassVar[str] = "logged_calls"
    __table_args__ = (
        UniqueConstraint("project", "id", name="uq_logged_calls_project_span"),
    )

    row_id: int | None = Field(default=None, primary_key=True)
    # Use 'meta' internally, map to 'metadata' column in DB
    meta: dict[str, object] | None = Field(
        default=None, sa_column=Column("metadata", JSON)
    )

    # === NEW: Langfuse-style observability fields ===
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
    end_time: datetime | None = Field(
        default=None
    )  # Explicit end time (may differ from created_at + latency)
    prompt_tokens: int | None = Field(default=None)  # Input token count
    completion_tokens: int | None = Field(default=None)  # Output token count

    # === NEW: Session and context fields ===
    session_id: str | None = Field(default=None, index=True)  # Link to session
    environment: str = Field(default="default")  # Environment name
    tags: list[str] = Field(
        default_factory=list, sa_column=Column("tags", JSON)
    )  # Tags for categorization

    # === NEW: Langfuse-inspired enhancements ===

    # Computed token total
    total_tokens: int | None = Field(default=None)

    # Prompt management integration
    prompt_id: str | None = Field(default=None, index=True)
    prompt_version: int | None = Field(default=None)

    # Cost (SPEC-136 ticket 06): micro-USD int totals + per-call frozen storage.
    provided_cost: int | None = Field(default=None)
    cost_breakdown: dict[str, int] | None = Field(
        default=None, sa_column=Column("cost_breakdown", JSON)
    )
    raw_usage: dict[str, int] | None = Field(
        default=None, sa_column=Column("raw_usage", JSON)
    )
    matched_tier_id: int | None = Field(default=None)
    matched_tier_name: str | None = Field(default=None)
    cost_provenance: str | None = Field(default=None)

    # Time metrics
    time_to_first_token_ms: float | None = Field(default=None)

    # Model tracking. internal_model_id references the matched models.id row.
    # Stored as a soft reference (not a hard FK) so re-pricing and model
    # deletion don't strand rows; the value is recomputed at compute time.
    provided_model_name: str | None = Field(default=None)
    internal_model_id: int | None = Field(default=None)

    # Tool-specific fields
    tool_name: str | None = Field(default=None)
    tool_parameters: dict[str, object] | None = Field(
        default=None, sa_column=Column("tool_parameters", JSON)
    )
    tool_result: dict[str, object] | None = Field(
        default=None, sa_column=Column("tool_result", JSON)
    )


# ============================================================================
# Optimization Config
# ============================================================================


class AgentTaskBatchRunDB(SQLModel, table=True):
    __tablename__: ClassVar[str] = "agent_task_batch_runs"

    id: str = Field(primary_key=True)
    project: str = Field(index=True)
    selection_type: str = Field(index=True)
    selection_query: dict[str, object] | None = Field(
        default=None, sa_column=Column("selection_query", JSON)
    )
    task_root: str | None = None
    grep: str | None = None
    environment: str = "default"
    run_metadata: dict[str, object] | None = Field(
        default=None, sa_column=Column("run_metadata", JSON)
    )
    status: str = Field(index=True)
    total_tasks: int = 0
    passed_tasks: int = 0
    failed_tasks: int = 0
    errored_tasks: int = 0
    # Check-level rollup across all task runs — the "how well did it do" metric
    # that the dashboard pass-rate bar uses. Distinct from the task-level
    # passed_tasks/total_tasks counts (which are all-or-nothing per task).
    total_checks: int = 0
    passed_checks: int = 0
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    started_at: datetime | None = Field(
        default=None,
        sa_column=Column(UTCDateTime),
    )
    completed_at: datetime | None = Field(
        default=None,
        sa_column=Column(UTCDateTime),
    )
    trace_persistence_status: str = Field(default="pending", index=True)
    trace_error_message: str | None = None
    # SPEC-119: snapshot of the task source used when the batch was created.
    # Stored on the batch so historical runs stay explainable even if the
    # source is later re-synced to a different commit or removed entirely.
    task_source_type: str | None = None
    task_source_ref: str | None = None
    task_source_commit_sha: str | None = None
    task_source_subpath: str | None = None


class AgentTaskRunDB(SQLModel, table=True):
    __tablename__: ClassVar[str] = "agent_task_runs"

    id: str = Field(primary_key=True)
    batch_run_id: str = Field(foreign_key="agent_task_batch_runs.id", index=True)
    task_id: str = Field(index=True)
    task_path: str
    adapter_name: str | None = None
    status: str = Field(index=True)
    pass_result: bool | None = None
    started_at: datetime | None = Field(
        default=None,
        sa_column=Column(UTCDateTime),
    )
    completed_at: datetime | None = Field(
        default=None,
        sa_column=Column(UTCDateTime),
    )
    trace_run_id: str | None = None
    error_message: str | None = None
    trace_persistence_status: str = Field(default="pending", index=True)
    trace_error_message: str | None = None
    checks_json: list[dict[str, object]] | None = Field(
        default=None, sa_column=Column("checks_json", JSON)
    )
    transcript_json: dict[str, object] | None = Field(
        default=None, sa_column=Column("transcript_json", JSON)
    )
    deliverables_json: dict[str, object] | None = Field(
        default=None, sa_column=Column("deliverables_json", JSON)
    )
    total_cost: float | None = Field(default=None)
    total_tokens: int | None = Field(default=None)
    # SPEC-119: link the run back to the exact inventory row and resolved
    # commit SHA it executed against. ``task_inventory_id`` is nullable so
    # legacy runs (created before inventory existed) keep rendering.
    task_inventory_id: str | None = Field(default=None, index=True)
    task_source_commit_sha: str | None = None


class AgentTaskScheduleDB(SQLModel, table=True):
    __tablename__: ClassVar[str] = "agent_task_schedules"

    id: str = Field(primary_key=True)
    project: str = Field(index=True)
    name: str
    selection_type: str = Field(index=True)
    selection_query: dict[str, object] | None = Field(
        default=None, sa_column=Column("selection_query", JSON)
    )
    task_root: str | None = None
    grep: str | None = None
    environment: str = "default"
    cadence_type: str = Field(index=True)
    timezone: str = "UTC"
    hour: int = 9
    minute: int = 0
    day_of_week: int | None = None
    day_of_month: int | None = None
    # SPEC-069: adaptive (SM-2) scheduling bounds. Used only when
    # ``cadence_type == "adaptive"``; ignored for fixed-cadence schedules.
    min_interval_days: float = 1.0
    max_interval_days: float = 30.0
    enabled: bool = Field(default=True, index=True)
    last_triggered_at: datetime | None = None
    last_batch_run_id: str | None = None
    next_run_at: datetime | None = None
    run_metadata: dict[str, object] | None = Field(
        default=None, sa_column=Column("run_metadata", JSON)
    )
    # SPEC-119: schedule provenance. Stored without commit_sha on purpose
    # so the schedule stays valid against the moving ref; the batch run
    # created at trigger time captures the resolved SHA.
    task_source_type: str | None = None
    task_source_ref: str | None = None
    task_source_subpath: str | None = None
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(
            UTCDateTime, server_default=func.now(), onupdate=func.now()
        ),
    )


class AdaptiveTaskStateDB(SQLModel, table=True):
    """Per-task adaptive scheduling state (SPEC-069).

    Each row tracks one task's SM-2 interval/ease within a single adaptive
    schedule. The schedule's ``next_run_at`` is the min of all its states'
    ``next_run_at`` values.
    """

    __tablename__: ClassVar[str] = "adaptive_task_states"

    id: str = Field(primary_key=True)  # schedule_id + "||" + task_id
    schedule_id: str = Field(
        foreign_key="agent_task_schedules.id", index=True
    )
    task_id: str
    task_path: str = ""
    current_interval_days: float = 1.0
    ease_factor: float = 2.5
    consecutive_passes: int = 0
    last_run_at: datetime | None = None
    last_status: str | None = None  # "passed" | "failed" | "error"
    next_run_at: datetime | None = Field(default=None, index=True)


class AnnotationQueueDB(SQLModel, table=True):
    """
    Annotation queue for human scoring of traces and observations.
    """

    __tablename__: ClassVar[str] = "annotation_queues"

    id: int | None = Field(default=None, primary_key=True)
    project: str = Field(index=True)
    name: str = Field(index=True)
    target_type: str = Field(index=True, description="TRACE or OBSERVATION")
    score_config_id: int | None = Field(
        default=None, foreign_key="score_configs.id", index=True
    )
    total_items: int = Field(default=0)
    completed_items: int = Field(default=0)
    is_active: bool = Field(default=True, index=True)

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(
            UTCDateTime, server_default=func.now(), onupdate=func.now()
        ),
    )


class WebhookDB(SQLModel, table=True):
    __tablename__: ClassVar[str] = "webhooks"

    id: int | None = Field(default=None, primary_key=True)
    project: str = Field(index=True)
    url: str
    description: str | None = Field(default=None)
    events: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    secret: str
    enabled: bool = Field(default=True, index=True)
    last_delivery_at: datetime | None = Field(default=None)
    last_delivery_status: str | None = Field(default=None)
    consecutive_failures: int = Field(default=0)

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(
            UTCDateTime, server_default=func.now(), onupdate=func.now()
        ),
    )


class CommentDB(SQLModel, table=True):
    __tablename__: ClassVar[str] = "comments"

    id: str = Field(primary_key=True)
    project_id: str = Field(index=True)
    object_id: str = Field(index=True)
    object_type: str = Field(index=True)
    content: str = Field(sa_column=Column("content", Text))
    author_id: str | None = Field(default=None)
    author_name: str | None = Field(default=None)
    parent_comment_id: str | None = Field(default=None)
    mentioned_user_ids: list[str] | None = Field(
        default=None, sa_column=Column("mentioned_user_ids", JSON)
    )

    # Inline-comment anchor: pins a comment to a text selection within an
    # observation's input/output/metadata JSON. Nullable for whole-object
    # comments. selection_path/range_start/range_end are parallel arrays
    # (one entry per row spanned by the selection).
    selection_field: str | None = Field(default=None)
    selection_path: list[str] | None = Field(
        default=None, sa_column=Column("selection_path", JSON)
    )
    selection_range_start: list[int] | None = Field(
        default=None, sa_column=Column("selection_range_start", JSON)
    )
    selection_range_end: list[int] | None = Field(
        default=None, sa_column=Column("selection_range_end", JSON)
    )
    selected_text: str | None = Field(default=None)

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(
            UTCDateTime, server_default=func.now(), onupdate=func.now()
        ),
    )


class CommentReactionDB(SQLModel, table=True):
    __tablename__: ClassVar[str] = "comment_reactions"

    id: int | None = Field(default=None, primary_key=True)
    comment_id: str = Field(foreign_key="comments.id", index=True)
    emoji: str
    user_id: str = Field(index=True)

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )

    __table_args__: ClassVar[tuple[object, ...]] = (
        UniqueConstraint("comment_id", "emoji", "user_id", name="uq_comment_reaction"),
    )


class ApiKeyDB(SQLModel, table=True):
    """API key record supporting both the two-key model (pk-apo/sk-apo) and legacy single keys.

    Two-key model (new):
        - ``public_key``: stable identifier (pk-apo-<uuid>), safe to expose in browsers/logs.
        - ``hashed_secret_key``: SHA256(secret + SALT), authenticates full-access requests.
        - ``display_secret_key``: masked form for UI lists (e.g. ``sk-apo-b1c2d3...8901``).

    Legacy single-key model (backward compat):
        - ``hashed_key``: SHA256 of the old ``sk-<hex>`` token. Nullable for new keys.
    """

    __tablename__: ClassVar[str] = "api_keys"

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:20])
    name: str = Field(default="Default")

    # Two-key model (SPEC-092). Nullable for backward compat with legacy keys.
    public_key: str | None = Field(default=None, unique=True, index=True)
    hashed_secret_key: str | None = Field(default=None, unique=True, index=True)
    display_secret_key: str = Field(default="")

    # Legacy single-key support (kept for backward compat). Nullable for new keys.
    hashed_key: str | None = Field(default=None, index=True)

    # Reused for public_key[:8] on new keys, or legacy key[:8] on old keys.
    prefix: str = Field(index=True)
    project: str = Field(index=True)
    created_by: str = Field(index=True)
    scope: str = Field(default="full")
    expires_at: datetime | None = Field(default=None)
    last_used_at: datetime | None = Field(default=None)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )


class UserDB(SQLModel, table=True):
    __tablename__: ClassVar[str] = "users"

    id: str = Field(default_factory=lambda: str(uuid4()), primary_key=True)
    email: str = Field(unique=True, index=True)
    name: str = Field(default="")
    password_hash: str
    is_admin: bool = Field(default=False)
    is_active: bool = Field(default=True, index=True)
    email_verified_at: datetime | None = Field(default=None)
    token_invalid_before: datetime | None = Field(default=None)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )


class EmailVerificationTokenDB(SQLModel, table=True):
    __tablename__: ClassVar[str] = "email_verification_tokens"

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:20])
    user_id: str = Field(foreign_key="users.id", index=True)
    code_hash: str = Field(unique=True, index=True)
    expires_at: datetime
    used_at: datetime | None = Field(default=None)
    attempts: int = Field(default=0)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )


class PasswordResetTokenDB(SQLModel, table=True):
    __tablename__: ClassVar[str] = "password_reset_tokens"

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:20])
    user_id: str = Field(foreign_key="users.id", index=True)
    token_hash: str = Field(unique=True, index=True)
    expires_at: datetime
    used_at: datetime | None = Field(default=None)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )


class ProjectDB(SQLModel, table=True):
    """A project is the main organizational unit for agent testing.

    All traces, task runs, batch runs, schedules, and API keys belong
    to a project. Users create projects after signing in. The demo
    project ('demo') is seeded automatically and accessible read-only.
    """

    __tablename__: ClassVar[str] = "projects"

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:12])
    name: str = Field(index=True)
    trace_content_policy: str = Field(default="full")
    created_by: str | None = Field(default=None, foreign_key="users.id", index=True)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now(), onupdate=func.now()),
    )


class ProjectMembershipDB(SQLModel, table=True):
    """Project-scoped membership row (SPEC-122).

    Replaces the use of ``ProjectDB.created_by`` and ``UserDB.is_admin``
    for product authorization. Each non-demo project has at least one
    membership row (``role="owner"`` for the creator). The demo project
    is intentionally world-readable and does not have membership rows.

    Roles (lowest to highest privilege): ``member`` < ``admin`` < ``owner``.
    """

    __tablename__: ClassVar[str] = "project_memberships"
    __table_args__ = (
        UniqueConstraint(
            "project_id", "user_id", name="uq_project_membership"
        ),
    )

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:16])
    project_id: str = Field(foreign_key="projects.id", index=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    role: str = Field(index=True)  # "owner" | "admin" | "member"
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now(), onupdate=func.now()),
    )


class ProjectInvitationDB(SQLModel, table=True):
    """Pending project-scoped invitation (SPEC-127).

    Lets project admins/owners invite a user by email even when no
    account exists yet. The raw token is never persisted — only its
    SHA-256 hash. The demo project never has invitation rows.

    At most one *active* (``accepted_at IS NULL AND revoked_at IS NULL``)
    row may exist per ``(project_id, email)``; re-inviting the same
    email refreshes the existing row in place instead of inserting a
    duplicate.
    """

    __tablename__: ClassVar[str] = "project_invitations"
    __table_args__: ClassVar[tuple[object, ...]] = (
        Index(
            "uq_project_invitations_active_email",
            "project_id",
            "email",
            unique=True,
            sqlite_where=text("accepted_at IS NULL AND revoked_at IS NULL"),
            postgresql_where=text("accepted_at IS NULL AND revoked_at IS NULL"),
        ),
    )

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:16])
    project_id: str = Field(foreign_key="projects.id", index=True)
    email: str = Field(index=True)
    role: str = Field(index=True)  # "owner" | "admin" | "member"
    invited_by_user_id: str = Field(foreign_key="users.id", index=True)
    token_hash: str = Field(index=True, unique=True)
    invite_url_path: str | None = Field(default=None)
    delivery_method: str = Field(default="email")  # "email" | "link_only"
    expires_at: datetime = Field(sa_column=Column(UTCDateTime, index=True))
    accepted_at: datetime | None = Field(
        default=None, sa_column=Column(UTCDateTime, index=True)
    )
    accepted_by_user_id: str | None = Field(default=None, foreign_key="users.id")
    revoked_at: datetime | None = Field(
        default=None, sa_column=Column(UTCDateTime, index=True)
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now(), onupdate=func.now()),
    )


class ProjectTaskSourceDB(SQLModel, table=True):
    """Project-owned task source configuration (SPEC-118).

    Each project owns exactly one task source row that determines where
    its task inventory comes from. New non-demo projects start without a
    row (backend returns ``null``); configuring the source creates a row
    with ``status="pending_sync"``. Later specs (SPEC-119) move status
    to ``ready`` once inventory has been synced.
    """

    __tablename__: ClassVar[str] = "project_task_sources"

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:16])
    project: str = Field(foreign_key="projects.id", index=True, unique=True)
    source_type: str = Field(index=True)  # "git" | "filesystem" | "demo"
    display_name: str

    repository_url: str | None = None
    git_ref: str | None = None
    subpath: str | None = None

    filesystem_path: str | None = None
    demo_seed_id: str | None = None

    status: str = Field(index=True)  # "unconfigured" | "pending_sync" | "ready" | "error"
    last_synced_at: datetime | None = Field(default=None, sa_column=Column(UTCDateTime))
    last_resolved_commit_sha: str | None = None
    last_error: str | None = None

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now(), onupdate=func.now()),
    )


class ProjectTaskInventoryDB(SQLModel, table=True):
    """Persisted task inventory row (SPEC-119).

    Inventory is the source of truth for "what tasks exist" on a project
    once its task source has been synced. Rows are replaced in-place on
    every successful sync of the source, so each row always reflects the
    latest resolved commit SHA (or filesystem snapshot) of its source.

    Historical runs do not depend on these rows staying current — they
    carry their own ``task_path``/``task_inventory_id``/commit SHA so
    they keep rendering even after a task disappears from inventory.
    """

    __tablename__: ClassVar[str] = "project_task_inventory"

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:20])
    project: str = Field(foreign_key="projects.id", index=True)
    task_source_id: str = Field(
        foreign_key="project_task_sources.id", index=True
    )

    task_id: str = Field(index=True)
    display_name: str
    adapter_name: str | None = None
    folder_path: str
    task_path: str

    has_checks: bool = False
    has_user_simulator: bool = False
    tags_json: list[str] | None = Field(
        default=None, sa_column=Column("tags_json", JSON)
    )

    source_type: str
    source_ref: str | None = None
    source_commit_sha: str | None = None
    source_subpath: str | None = None
    discovered_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )


class GithubConnectionDB(SQLModel, table=True):
    """Per-project GitHub OAuth connection (SPEC-121).

    Stores the encrypted access token and the GitHub user identity so
    project task sources can clone from private GitHub repositories
    without asking each user to manage their own PAT.

    One row per project (unique constraint on ``project``). Reconnecting
    replaces the existing row.
    """

    __tablename__: ClassVar[str] = "github_connections"

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:20])
    project: str = Field(foreign_key="projects.id", index=True, unique=True)
    github_user_id: str = Field(index=True)
    github_username: str | None = None

    access_token_encrypted: str
    scopes_granted: str | None = None
    token_type: str | None = None

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now(), onupdate=func.now()),
    )


# ============================================================================
# SPEC-129: OTel-Native Tracing — Canonical OTLP span store + durable inbox
# ============================================================================


class OtlpIngestBatchDB(SQLModel, table=True):
    """Durable inbox record for a received OTLP batch (SPEC-129 Track 1).

    Persisted before any derived processing so convention changes, transient
    projection failures, and newly supported frameworks can be replayed from
    the raw payload.
    """

    __tablename__: ClassVar[str] = "otlp_ingest_batches"

    id: str = Field(primary_key=True)  # batch UUID
    project_id: str = Field(index=True)  # from auth, never from payload
    received_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    content_type: str = Field(default="application/json")
    payload_sha256: str = Field(default="")
    payload: str = Field(sa_column=Column(Text))  # policy-sanitized OTLP payload
    accepted_span_count: int = Field(default=0)
    rejected_span_count: int = Field(default=0)
    content_policy: str = Field(default="full")
    verified_task_run_id: str | None = Field(default=None, index=True)
    processing_started_at: datetime | None = Field(
        default=None, sa_column=Column(UTCDateTime)
    )
    status: str = Field(default="accepted", index=True)
    error_message: str | None = Field(default=None)


class OtlpSpanDB(SQLModel, table=True):
    """Canonical lossless OTel span store (SPEC-129 Track 2).

    One row per ``(project_id, trace_id, span_id)`` — the immutable source of
    truth. Typed OTel values are retained as JSON for replayability.
    """

    __tablename__: ClassVar[str] = "otlp_spans"
    __table_args__ = (
        UniqueConstraint("project_id", "trace_id", "span_id", name="uq_otlp_span"),
        Index("ix_otlp_spans_trace", "project_id", "trace_id"),
    )

    id: int | None = Field(default=None, primary_key=True)
    project_id: str = Field(index=True)
    trace_id: str = Field(index=True)
    span_id: str = Field(index=True)
    parent_span_id: str | None = Field(default=None, index=True)
    start_time: datetime | None = Field(default=None, sa_column=Column(UTCDateTime))
    end_time: datetime | None = Field(default=None, sa_column=Column(UTCDateTime))
    span_name: str = Field(default="")
    span_kind: int = Field(default=0)
    status_code: int = Field(default=0)
    status_message: str | None = Field(default=None)
    trace_flags: int = Field(default=0)
    trace_state: str | None = Field(default=None)

    resource: dict[str, object] | None = Field(default=None, sa_column=Column(JSON))
    instrumentation_scope: dict[str, object] | None = Field(
        default=None, sa_column=Column(JSON)
    )
    attributes: dict[str, object] | None = Field(default=None, sa_column=Column(JSON))
    events: list[dict[str, object]] | None = Field(default=None, sa_column=Column(JSON))
    links: list[dict[str, object]] | None = Field(default=None, sa_column=Column(JSON))
    raw_span: dict[str, object] | None = Field(default=None, sa_column=Column(JSON))

    content_policy: str = Field(default="default")
    projection_version: int = Field(default=0)

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
