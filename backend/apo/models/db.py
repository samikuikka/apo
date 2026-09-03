# pyright: reportIncompatibleVariableOverride=false, reportUnannotatedClassAttribute=false

from datetime import datetime, timezone
from typing import ClassVar, final, override
from uuid import uuid4

from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Index,
    String,
    TypeDecorator,
    UniqueConstraint,
    Text,
)
from sqlalchemy.engine import Dialect
from sqlalchemy.sql import func, text
from sqlmodel import JSON, Field, SQLModel

from ..models.schemas import JsonValue, LoggedCallBase


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

    M4: ``id`` is the OTel trace ID (not the PK). The PK is a
    surrogate ``row_id`` so two projects can each project the same trace ID.
    """

    __tablename__: ClassVar[str] = "runs"
    __table_args__ = (
        UniqueConstraint("project", "id", name="uq_runs_project_trace"),
        # The traces list defaults to unfiltered time — push the
        # project scan down a created_at-ordered index.
        Index("ix_runs_project_created", "project", "created_at"),
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
    run_metadata: JsonValue | None = Field(
        default=None, sa_column=Column("metadata", JSON)
    )  # Arbitrary metadata (renamed from 'metadata' which is reserved)
    # Trace-level aggregate input/output (Langfuse-style): what started the
    # trace and the final result. Per-call I/O still lives on LoggedCall.
    input: JsonValue | None = Field(
        default=None, sa_column=Column("input", JSON)
    )
    output: JsonValue | None = Field(
        default=None, sa_column=Column("output", JSON)
    )
    # The trace's service (resource service.name of its spans) — denormalized
    # for the traces LIST column (the search filter reads the span side; the list
    # display made a run-level copy cheaper than a per-row span join).
    service_name: str | None = Field(default=None)
    # Storage single-homing Stage 2: write-time previews for the traces
    # LIST. Each slot is derived independently from its own best source
    # call (root call with a payload on that side, else first GENERATION,
    # else first call — see projection_io.maybe_update_run_preview); they
    # live and die with the projection row, never with the source call.
    input_preview: str | None = Field(default=None)
    output_preview: str | None = Field(default=None)
    # Soft references, one per slot — a one-sided root owns only the side
    # it can actually fill, so the other slot's source stays trackable.
    input_preview_call_row_id: int | None = Field(default=None)
    output_preview_call_row_id: int | None = Field(default=None)
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
    # project scope so metrics can be resolved without a join through
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
    )  # API (programmatic), EVAL (automated)
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
    # project scope so metrics can be resolved without a join through
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
    source: str = Field(default="API", index=True)  # API, EVAL
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

    # Cost: micro-USD int totals + per-call frozen storage.
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
    tool_parameters: JsonValue | None = Field(
        default=None, sa_column=Column("tool_parameters", JSON)
    )
    tool_result: JsonValue | None = Field(
        default=None, sa_column=Column("tool_result", JSON)
    )


# ============================================================================
# Optimization Config
# ============================================================================


class AgentTaskBatchRunDB(SQLModel, table=True):
    __tablename__: ClassVar[str] = "agent_task_batch_runs"
    __table_args__: ClassVar[tuple[object, ...]] = (
        # Hot path: the runs list filters by project, orders by created_at DESC,
        # then paginates. Without this composite, SQLite filesorts every page.
        Index("ix_batch_runs_project_created", "project", "created_at"),
    )

    id: str = Field(primary_key=True)
    project: str = Field(index=True)
    selection_type: str = Field(index=True)
    selection_query: dict[str, object] | None = Field(
        default=None, sa_column=Column("selection_query", JSON)
    )
    task_root: str | None = None
    grep: str | None = None
    environment: str = "default"
    requested_by_user_id: str | None = Field(default=None, foreign_key="users.id", index=True)
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
    # snapshot of the task source used when the batch was created.
    # Stored on the batch so historical runs stay explainable even if the
    # source is later re-synced to a different commit or removed entirely.
    task_source_type: str | None = None
    task_source_ref: str | None = None
    task_source_commit_sha: str | None = None
    task_source_subpath: str | None = None
    # pooled execution target (resolved once at Batch creation) and
    # cancelled-task rollup. execution_target_json never retargets.
    execution_target_json: dict[str, object] | None = Field(
        default=None, sa_column=Column("execution_target_json", JSON)
    )
    cancelled_tasks: int = 0


class AgentTaskRunDB(SQLModel, table=True):
    __tablename__: ClassVar[str] = "agent_task_runs"
    __table_args__: ClassVar[tuple[object, ...]] = (
        # composite index for the model/effort filtering and
        # comparison dimensions across a batch's children.
        Index(
            "ix_agent_task_runs_configuration",
            "configured_model",
            "configured_effort",
            "batch_run_id",
        ),
    )

    id: str = Field(primary_key=True)
    batch_run_id: str = Field(foreign_key="agent_task_batch_runs.id", index=True)
    task_id: str = Field(index=True)
    task_path: str
    # ordered position within a sequential Batch. Lower index must
    # be terminal before a higher-index Attempt becomes claim-eligible.
    sequence_index: int = 0
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
    # scalar verdict projection of the Check Report. The hot list/stats
    # path reads these and never touches the evidence document. The legacy
    # inline ``checks_json`` copy was dropped in schema v28 —
    # the report table is the only evidence store.
    total_checks: int = Field(default=0)
    passed_checks: int = Field(default=0)
    failed_checks: int = Field(default=0)
    transcript_json: dict[str, object] | None = Field(
        default=None, sa_column=Column("transcript_json", JSON)
    )
    total_cost: float | None = Field(default=None)
    total_tokens: int | None = Field(default=None)
    # Count of calls whose model had no matching pricing era (issue #94). When
    # non-zero, ``total_cost`` is a partial sum and must not be presented as a
    # complete total — the unpriced calls silently contributed 0. Rolled up by
    # ``NativeTraceBackend.aggregate_costs`` from per-call ``cost_provenance``.
    unpriced_call_count: int = Field(default=0)
    # Bounded execution provenance derived from canonical OTel Generation
    # Observations. Null means APO has no canonical generation evidence for the
    # run (for example, a legacy trace), not that zero generations errored.
    generation_execution_json: dict[str, object] | None = Field(
        default=None, sa_column=Column(JSON)
    )
    # adapter-reported Run Configuration. Typed, indexed product
    # dimensions — never backfilled from adapter name, env, or trace data.
    # Both columns nullable so legacy rows remain readable as "unknown".
    configured_model: str | None = Field(default=None)
    configured_effort: str | None = Field(default=None)
    # link the run back to the exact inventory row and resolved
    # commit SHA it executed against. ``task_inventory_id`` is nullable so
    # legacy runs (created before inventory existed) keep rendering.
    task_inventory_id: str | None = Field(default=None, index=True)
    task_source_commit_sha: str | None = None
    # Pinned Task Definition Revision for this Run.
    task_definition_revision_id: str | None = Field(
        default=None, foreign_key="task_definition_revisions.id", index=True
    )
    # Number of Tests whose effective result differs from the
    # recorded one (latest active correction per Test). Maintained by the
    # correction service in the same transaction as the verdict scalars.
    corrected_tests: int = Field(default=0)


class AgentTaskCheckReportDB(SQLModel, table=True):
    """A Task Run's full check evidence, stored off the hot row.

    The run row carries only the scalar verdict (``total_checks`` /
    ``passed_checks`` / ``failed_checks``); the per-check reasoning, judge
    segments, and assertions live here and are loaded only by the detail /
    compare / CLI path via ``check_report_storage.load_check_report``. Always
    inline JSON — checks are bounded by per-field hygiene, not file artifacts,
    so they do not use the ArtifactStore (unlike Deliverables).

    Cleanup is belt-and-suspenders: retention's ``_delete_old_batch_runs``
    pre-deletes report rows explicitly (mirroring attempts / task_revisions),
    and the FK is ``ON DELETE CASCADE`` as defense when SQLite
    ``foreign_keys=ON`` (set at ``db.py`` connect time). Either path alone is
    sufficient; both keep purge robust and testable without pragma gymnastics.
    """

    __tablename__: ClassVar[str] = "agent_task_check_reports"

    run_id: str = Field(
        sa_column=Column(
            "run_id",
            ForeignKey("agent_task_runs.id", ondelete="CASCADE"),
            primary_key=True,
        )
    )
    value_json: list[dict[str, object]] | None = Field(
        default=None, sa_column=Column("value_json", JSON)
    )
    created_at: datetime


class AgentTaskDeliverableDB(SQLModel, table=True):
    """A named Task Run Deliverable (JSON value or file Artifact).

    Owns Deliverable identity and metadata. The ``inline_value_json`` body and
    ``storage_key`` are never selected by list/manifest/detail queries — only
    by an explicit one-body fetch. See ``agent_task_deliverables`` service for
    the placement rules (inline vs object store) and invariants.
    """

    __tablename__: ClassVar[str] = "agent_task_deliverables"
    __table_args__ = (
        UniqueConstraint(
            "project",
            "task_run_id",
            "name",
            name="uq_agent_task_deliverable_name",
        ),
    )

    id: str = Field(primary_key=True)
    project: str = Field(index=True)
    task_run_id: str = Field(
        foreign_key="agent_task_runs.id",
        index=True,
    )
    name: str
    kind: str  # "json" | "artifact"
    status: str  # "pending" | "ready" | "failed"
    storage_backend: str | None = None  # None | "local" | "s3"
    storage_key: str | None = None
    inline_value_json: dict[str, object] | None = Field(
        default=None,
        sa_column=Column("inline_value_json", JSON),
    )
    display_filename: str | None = None
    media_type: str
    content_encoding: str = "identity"  # "identity" | "gzip"
    size_bytes: int
    stored_size_bytes: int | None = None
    sha256: str
    error_message: str | None = None
    created_at: datetime
    ready_at: datetime | None = None


class AgentTaskJudgmentDB(SQLModel, table=True):
    """Issue #159: a recorded re-evaluation of a completed Task Run.

    A Run's verdict is welded to the judge that ran it; a judgment is the
    outcome of replaying the Run's Phase-2 checks against its stored
    Deliverables — typically under a different judge model, fixed check
    code, or for a per-test stability estimate (``samples > 1``).

    Only ``rejudge`` judgments are stored. The Run's original verdict stays
    where it always lived (run scalar columns + ``AgentTaskCheckReportDB``)
    and is synthesized as the trigger=``original`` judgment on read, so
    nothing that reads runs today changes meaning and the original is never
    overwritten. Replay always records the full check set — there is no
    per-check re-judging, which would ratchet a ~16%-unstable verdict
    toward PASS.

    Retention mirrors check reports: the FK is ``ON DELETE CASCADE`` and
    retention pre-deletes judgment rows when the Run's Batch is purged.
    """

    __tablename__: ClassVar[str] = "agent_task_judgments"

    id: str = Field(primary_key=True, default_factory=lambda: f"jdg_{uuid4().hex[:16]}")
    task_run_id: str = Field(
        foreign_key="agent_task_runs.id",
        index=True,
    )
    # Denormalized from the Run's Batch for project-scoped queries, mirroring
    # AgentTaskDeliverableDB.
    project: str = Field(index=True)
    trigger: str = "rejudge"
    label: str | None = None
    # Resolved judge configuration actually used — model and base URL only;
    # an API key is never recorded.
    judge_model: str | None = None
    judge_base_url: str | None = None
    task_definition_revision_id: str | None = Field(
        default=None, foreign_key="task_definition_revisions.id"
    )
    samples: int = 1
    pass_result: bool | None = None
    total_checks: int = 0
    passed_checks: int = 0
    failed_checks: int = 0
    # Full check evidence from the primary sample, same shape as
    # agent_task_check_reports.value_json.
    checks_json: list[dict[str, object]] | None = Field(
        default=None, sa_column=Column("checks_json", JSON)
    )
    # Per-check pass counts across samples, e.g.
    # [{"check_id": "...", "passes": 2, "samples": 5}]. Null for samples=1.
    stability_json: list[dict[str, object]] | None = Field(
        default=None, sa_column=Column("stability_json", JSON)
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )


class AgentTaskTestResultCorrectionDB(SQLModel, table=True):
    """An append-only human decision about a recorded Test result.

    A correction sets one top-level Test of one Task Run to an effective
    PASS/FAIL (or clears back to the recorded result) without touching the
    Check Report, assertions, judge evidence, or judgments. Run verdict
    scalars are re-derived from the effective projection by the correction
    service; this row is the audit trail that makes the projection
    reproducible (including as-of projection for old comparison snapshots).

    The FK is ``ON DELETE CASCADE``, but SQLite deployments do not always
    enforce FKs — retention and project deletion pre-delete correction rows
    explicitly, mirroring check reports and judgments.
    """

    __tablename__: ClassVar[str] = "agent_task_test_result_corrections"
    __table_args__: ClassVar[tuple[object, ...]] = (
        # Latest-action-per-test lookup: filter by run+test, read newest first.
        Index(
            "ix_agent_task_test_result_corrections_lookup",
            "task_run_id",
            "test_id",
            "created_at",
            "id",
        ),
    )

    id: str = Field(primary_key=True, default_factory=lambda: f"cor_{uuid4().hex[:16]}")
    task_run_id: str = Field(foreign_key="agent_task_runs.id", index=True)
    # Denormalized from the Run's Batch for project-scoped queries, mirroring
    # AgentTaskJudgmentDB.
    project: str = Field(index=True)
    test_id: str
    action: str  # set_pass | set_fail | clear
    reason: str | None = None
    corrected_by_user_id: str | None = None
    corrected_via: str = "session"  # session | api_key | open_dev
    api_key_id: str | None = None
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )


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
    # adaptive (SM-2) scheduling bounds. Used only when
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
    # schedule provenance. Stored without commit_sha on purpose
    # so the schedule stays valid against the moving ref; the batch run
    # created at trigger time captures the resolved SHA.
    task_source_type: str | None = None
    task_source_ref: str | None = None
    task_source_subpath: str | None = None
    # schedule target Pool + queue policy + disabled reason. Pool is
    # nullable only for migration/historical rows; new validation requires it.
    # archived Pool disables with disabled_reason="executor_pool_archived".
    executor_pool_id: str | None = Field(default=None, foreign_key="executor_pools.id", index=True)
    queue_ttl_seconds: int = 86_400
    disabled_reason: str | None = None
    # source-owned scheduled delivery. ``execution_kind`` distinguishes
    # native source-owned schedules from legacy bundled ones. The authenticated
    # creator becomes the fixed Execution Owner; only their Connected Executors
    # may claim. ``active_batch_run_id`` enforces at-most-one non-terminal Batch
    # per Schedule. Legacy rows backfill to ``bundled`` with null owner/active.
    execution_kind: str = Field(default="bundled", index=True)
    execution_owner_user_id: str | None = Field(
        default=None, foreign_key="users.id", index=True
    )
    active_batch_run_id: str | None = Field(
        default=None, foreign_key="agent_task_batch_runs.id", index=True
    )
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


class AgentTaskScheduleOccurrenceDB(SQLModel, table=True):
    """Durable identity for one due Schedule time.

    Either owns one 24-hour queued Batch or is recorded as missed. The unique
    ``(schedule_id, kind, scheduled_for)`` identity makes dispatch idempotent
    across duplicate polls and restarts — a retry re-reads the existing
    Occurrence rather than creating a second Batch.
    """

    __tablename__: ClassVar[str] = "agent_task_schedule_occurrences"
    __table_args__: ClassVar[tuple[object, ...]] = (
        UniqueConstraint(
            "schedule_id",
            "kind",
            "scheduled_for",
            name="uq_schedule_occurrence_time",
        ),
        Index("ix_schedule_occurrence_status", "schedule_id", "status"),
    )

    id: str = Field(primary_key=True)
    project: str = Field(foreign_key="projects.id", index=True)
    schedule_id: str = Field(index=True)
    schedule_name: str
    kind: str = Field(index=True)  # scheduled | manual
    scheduled_for: datetime = Field(sa_column=Column(UTCDateTime, index=True))
    status: str = Field(index=True)  # pending | delivered | missed | cancelled
    batch_run_id: str | None = Field(
        default=None, foreign_key="agent_task_batch_runs.id", unique=True, index=True
    )
    missed_reason: str | None = None
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    resolved_at: datetime | None = Field(default=None, sa_column=Column(UTCDateTime))


class AdaptiveTaskStateDB(SQLModel, table=True):
    """Per-task adaptive scheduling state.

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

    # Two-key model. Nullable for backward compat with legacy keys.
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
    # Ingest guardrails. Quota is PER KEY (N keys = N x cap) and
    # guards against accidents, not adversarial senders. NULL = unlimited.
    daily_span_quota: int | None = Field(default=None)
    ingest_paused: bool = Field(default=False)
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
    # Per-project evidence-retention override (days). NULL = inherit the
    # APO_EVIDENCE_RETENTION_DAYS default; 0 = keep this project's evidence
    # forever even when the default says otherwise. Verdicts are never
    # deleted automatically, whatever this says.
    evidence_retention_days: int | None = Field(default=None)
    # default Pool for dashboard/schedule runs. Deliberately NOT a
    # hard DB foreign key (that would form a projects <-> executor_pools cycle
    # that breaks CREATE/DROP ordering); the service validates that the Pool
    # belongs to this Project. Never retargets after Batch creation.
    default_executor_pool_id: str | None = None
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
    """Project-scoped membership row.

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
    """Pending project-scoped invitation.

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


class HostedAccessInvitationDB(SQLModel, table=True):
    """Installation-level admission invitation.

    Lets an Installation Administrator admit one person to the APO
    installation; acceptance creates or reuses the invited User and
    materializes exactly one new invitee-owned Project. Admission is
    never Project membership: no Project exists at issue time and the
    issuer gains nothing.

    The raw token is never persisted — only its SHA-256 hash. At most
    one *active* (``accepted_at IS NULL AND revoked_at IS NULL``) row may
    exist per normalized email; re-inviting refreshes in place.
    ``accepted_project_id`` is an audit reference only, deliberately not
    a foreign key (it may outlive the Project row).
    """

    __tablename__: ClassVar[str] = "hosted_access_invitations"
    __table_args__: ClassVar[tuple[object, ...]] = (
        Index(
            "uq_hosted_access_invitations_active_email",
            "email",
            unique=True,
            sqlite_where=text("accepted_at IS NULL AND revoked_at IS NULL"),
            postgresql_where=text("accepted_at IS NULL AND revoked_at IS NULL"),
        ),
    )

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:20])
    email: str = Field(index=True)
    token_hash: str = Field(unique=True, index=True)
    invited_by_user_id: str = Field(foreign_key="users.id", index=True)
    delivery_method: str = Field(default="email")  # "email" | "link_only"
    expires_at: datetime = Field(sa_column=Column(UTCDateTime, index=True))
    accepted_at: datetime | None = Field(
        default=None, sa_column=Column(UTCDateTime, index=True)
    )
    accepted_by_user_id: str | None = Field(default=None, foreign_key="users.id")
    accepted_project_id: str | None = Field(default=None, index=True)
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
    """Project-owned task source configuration.

    Each project owns exactly one task source row that determines where
    its task inventory comes from. New non-demo projects start without a
    row (backend returns ``null``); configuring the source creates a row
    with ``status="pending_sync"``. Later specs move status
    to ``ready`` once inventory has been synced.
    """

    __tablename__: ClassVar[str] = "project_task_sources"

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:16])
    project: str = Field(foreign_key="projects.id", index=True, unique=True)
    source_type: str = Field(index=True)  # "git" | "filesystem" | "demo" | "published"
    display_name: str = ""

    # Task Catalog columns
    catalog_digest: str | None = None
    task_count: int | None = None
    published_at: datetime | None = Field(default=None, sa_column=Column(UTCDateTime))
    published_by_user_id: str | None = None

    repository_url: str | None = None
    git_ref: str | None = None
    subpath: str | None = None

    filesystem_path: str | None = None
    demo_seed_id: str | None = None

    status: str = Field(index=True)  # "unconfigured" | "pending_sync" | "ready" | "error"
    # Catalog schema version (1 = metadata-only, 2 = with definitions).
    catalog_schema_version: int = 1
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
    """Persisted task inventory row.

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
    tags_json: list[str] | None = Field(
        default=None, sa_column=Column("tags_json", JSON)
    )

    source_type: str
    source_ref: str | None = None
    source_commit_sha: str | None = None
    source_subpath: str | None = None
    # Pointer to the current published Task Definition Revision.
    task_definition_revision_id: str | None = Field(
        default=None, foreign_key="task_definition_revisions.id", index=True
    )
    discovered_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )


class TaskDefinitionRevisionDB(SQLModel, table=True):
    """Immutable, content-addressed Task Definition source.

    Stores the exact canonical ``*.eval.ts`` text that defines a Task and
    its Tests. Private Project data (like traces and Deliverables); never
    executed, transpiled, or imported by the backend. Deduplicated by
    ``(project, task_id, content_sha256)``.
    """

    __tablename__: ClassVar[str] = "task_definition_revisions"
    __table_args__: ClassVar[tuple[object, ...]] = (
        UniqueConstraint(
            "project",
            "task_id",
            "content_sha256",
            name="uq_task_definition_revision_identity",
        ),
    )

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:16])
    project: str = Field(foreign_key="projects.id", index=True)
    task_id: str = Field(index=True)
    schema_version: int = 1
    content_sha256: str = Field(index=True)
    source_files_json: list[dict[str, object]] = Field(
        default_factory=list, sa_column=Column(JSON)
    )
    source_size_bytes: int
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )


class TaskRevisionDB(SQLModel, table=True):
    """Immutable Task Revision identity for a Batch Run.

    A Revision pins the exact source bytes a Batch was recorded against. It is
    either ``bundled`` (the Control Plane stored a verified immutable Execution
    Bundle) or ``attested`` (the caller reported the canonical content digest
    without uploading bytes — not reproducible from apo).

    One Revision per Batch (``batch_run_id`` is unique). Historical Batches
    have no Revision and remain readable. Invariants (bundled requires every
    ``bundle_*`` field; attested forbids them; digests are lowercase 64-hex)
    are enforced by the service layer, not by DB constraints.
    """

    __tablename__: ClassVar[str] = "task_revisions"

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:16])
    project: str = Field(foreign_key="projects.id", index=True)
    batch_run_id: str = Field(
        foreign_key="agent_task_batch_runs.id", index=True  # uniqueness removed
    )
    materialization: str  # "attested" | "bundled"
    source_type: str
    source_ref: str | None = None
    commit_sha: str | None = None
    dirty: bool = False
    content_sha256: str = Field(index=True)
    file_count: int
    uncompressed_size_bytes: int
    manifest_summary_json: dict[str, object] = Field(sa_column=Column(JSON))
    bundle_storage_backend: str | None = None
    bundle_storage_key: str | None = None
    bundle_sha256: str | None = None
    bundle_size_bytes: int | None = None
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )


class TaskViewComparisonDB(SQLModel, table=True):
    """An immutable, selection-scoped view-vs-view comparison snapshot.

    Created when a user picks a set of tasks on the Tasks page and hits Compare.
    The resolved run-id-per-task-per-side + the def/exec revisions actually used
    are frozen at create time, so a shared link keeps its meaning even after
    tasks are re-run or deleted. The short opaque id is the only thing that
    appears in the shareable URL.

    No update endpoint exists — snapshots are create + read only.
    """

    __tablename__: ClassVar[str] = "task_view_comparison"

    id: str = Field(primary_key=True)  # 'tvc_' + 12 base32 chars
    project_id: str = Field(foreign_key="projects.id", index=True)
    view_a_config: dict[str, object] = Field(sa_column=Column(JSON))  # {"model": ..., "effort": ...}
    view_b_config: dict[str, object] = Field(sa_column=Column(JSON))
    task_ids: list[str] = Field(sa_column=Column(JSON))  # the selection scope
    resolved: list[dict[str, object]] = Field(sa_column=Column(JSON))  # ResolvedComparisonCell rows
    coverage: dict[str, object] = Field(sa_column=Column(JSON))  # both_run / aligned / scope
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    created_by: str | None = Field(default=None, foreign_key="users.id")


class TaskViewDB(SQLModel, table=True):
    """A user's saved evidence-view tab for a project.

    Derived tabs created on the Tasks page are persisted here so they survive
    refresh / cross-device. The permanent Main tab (model=null, effort=null,
    since=null) is never stored — it's always present implicitly. Only
    user-created tabs have rows. (project_id, user_id) scopes ownership.
    """

    __tablename__: ClassVar[str] = "task_view"

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:16])
    project_id: str = Field(foreign_key="projects.id", index=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    label: str
    model: str | None = None
    effort: str | None = None
    since: str | None = None
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )


class ArchivedModelDB(SQLModel, table=True):
    """A model the project has retired from its filter dropdowns.

    The model palette on the Runs and Tasks pages is derived from the distinct
    ``configured_model`` values on runs, so a model that ran once stays in the
    dropdown forever. A row here removes one from those lists.

    Presence is the state — there is no ``archived`` flag. Un-archiving deletes
    the row, which is also what a new run of that model does: a fresh run means
    the label is live again (see ``finalize_task_run_with_result``).

    Archiving is project-wide and display-only. It never hides runs, changes
    stats, or affects ``?model=`` filtering — a shared link or a saved view
    pinned to an archived model keeps working.
    """

    __tablename__: ClassVar[str] = "archived_model"
    __table_args__: ClassVar[tuple[object, ...]] = (
        UniqueConstraint("project_id", "model", name="uq_archived_model_project_model"),
    )

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:16])
    project_id: str = Field(foreign_key="projects.id", index=True)
    model: str
    archived_by_user_id: str | None = Field(default=None, foreign_key="users.id")
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )


# ============================================================================
# Execution Control Plane — Pools, Executors, Attempts
# ============================================================================


class ExecutorPoolDB(SQLModel, table=True):
    """Project-owned Executor Pool: a stable execution/trust target.

    Schedules and dashboard runs target a Pool rather than one transient
    machine. Instances in a Pool are expected to have equivalent network,
    credential, runtime, and driver access.
    """

    __tablename__: ClassVar[str] = "executor_pools"
    __table_args__: ClassVar[tuple[object, ...]] = (
        UniqueConstraint("project", "slug", name="uq_executor_pool_project_slug"),
    )

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:16])
    project: str = Field(foreign_key="projects.id", index=True)
    name: str
    slug: str
    kind: str = Field(index=True)  # bundled | connected | managed
    enabled: bool = Field(default=True, index=True)
    archived_at: datetime | None = Field(default=None, sa_column=Column(UTCDateTime))
    queue_ttl_seconds: int = 86_400
    required_driver_kind: str = "subprocess"
    created_by_user_id: str | None = Field(default=None, foreign_key="users.id")
    system_managed: bool = Field(default=False, index=True)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now(), onupdate=func.now()),
    )


class ExecutorDB(SQLModel, table=True):
    """A process that pulls work from the Control Plane.

    Persistent Executors enroll with a one-time token and authenticate with a
    long-lived ``apo_ex_`` credential whose raw value is returned once and only
    a hash/prefix persists.
    """

    __tablename__: ClassVar[str] = "executors"

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:16])
    scope_kind: str  # installation | pool
    project: str | None = Field(default=None, foreign_key="projects.id", index=True)
    executor_pool_id: str | None = Field(
        default=None, foreign_key="executor_pools.id", index=True
    )
    name: str
    enabled: bool = Field(default=True, index=True)
    credential_prefix: str
    credential_hash: str = Field(unique=True, index=True)
    protocol_version: int
    executor_version: str
    enrolled_by_user_id: str | None = Field(default=None, foreign_key="users.id", index=True)
    driver_kinds_json: list[str] | None = Field(default=None, sa_column=Column(JSON))
    capabilities_json: dict[str, object] | None = Field(
        default=None, sa_column=Column(JSON)
    )
    max_concurrency: int = 1
    # latest protocol-v2 heartbeat observations. Observations used
    # for UI freshness only; persisted ``max_concurrency`` plus active leased/
    # running Attempts remain the capacity authority.
    reported_catalog_digest: str | None = Field(default=None, index=True)
    reported_available_slots: int | None = None
    last_seen_at: datetime | None = Field(default=None, sa_column=Column(UTCDateTime))
    enrolled_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    revoked_at: datetime | None = Field(default=None, sa_column=Column(UTCDateTime))
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now(), onupdate=func.now()),
    )


class ExecutorEnrollmentTokenDB(SQLModel, table=True):
    """One-time token exchanged for a persistent Executor credential."""

    __tablename__: ClassVar[str] = "executor_enrollment_tokens"

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:16])
    project: str | None = Field(default=None, foreign_key="projects.id", index=True)
    executor_pool_id: str | None = Field(
        default=None, foreign_key="executor_pools.id", index=True
    )
    scope_kind: str  # installation | pool
    token_prefix: str
    token_hash: str = Field(unique=True, index=True)
    expires_at: datetime = Field(sa_column=Column(UTCDateTime))
    used_at: datetime | None = Field(default=None, sa_column=Column(UTCDateTime))
    revoked_at: datetime | None = Field(default=None, sa_column=Column(UTCDateTime))
    created_by_user_id: str | None = Field(default=None, foreign_key="users.id")
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )


class TaskExecutionAttemptDB(SQLModel, table=True):
    """One operational execution attempt of a Task Run.

    Owns queue/lease/Executor state, phase, operational failure, bounded
    diagnostics, and cancellation/loss — distinct from the Task Run which owns
    verdict/Checks/Deliverables/cost/Trace. Unique per Task Run.
    """

    __tablename__: ClassVar[str] = "task_execution_attempts"
    __table_args__: ClassVar[tuple[object, ...]] = (
        UniqueConstraint("task_run_id", name="uq_task_execution_attempt_run"),
        Index("ix_task_attempt_claim", "status", "executor_pool_id", "queued_at"),
        Index("ix_task_attempt_lease", "status", "lease_expires_at"),
    )

    id: str = Field(primary_key=True, default_factory=lambda: uuid4().hex[:16])
    project: str = Field(foreign_key="projects.id", index=True)
    batch_run_id: str = Field(foreign_key="agent_task_batch_runs.id", index=True)
    task_run_id: str = Field(foreign_key="agent_task_runs.id", index=True)
    task_revision_id: str | None = Field(
        default=None, foreign_key="task_revisions.id", index=True
    )
    sequence_index: int
    target_kind: str = Field(index=True)  # caller | pool
    assignment_kind: str = Field(default="bundled", index=True)  # caller | bundled | source_owned
    target_user_id: str | None = Field(
        default=None, foreign_key="users.id", index=True
    )
    executor_pool_id: str | None = Field(
        default=None, foreign_key="executor_pools.id", index=True
    )
    executor_id: str | None = Field(default=None, foreign_key="executors.id", index=True)
    status: str = Field(default="queued", index=True)
    phase: str | None = None
    lease_generation: int = 0
    lease_expires_at: datetime | None = Field(
        default=None, sa_column=Column("lease_expires_at", UTCDateTime, index=True)
    )
    queue_expires_at: datetime = Field(
        sa_column=Column("queue_expires_at", UTCDateTime, nullable=False, index=True)
    )
    queued_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    claimed_at: datetime | None = Field(default=None, sa_column=Column(UTCDateTime))
    started_at: datetime | None = Field(default=None, sa_column=Column(UTCDateTime))
    heartbeat_at: datetime | None = Field(default=None, sa_column=Column(UTCDateTime))
    completed_at: datetime | None = Field(default=None, sa_column=Column(UTCDateTime))
    cancel_requested_at: datetime | None = Field(default=None, sa_column=Column(UTCDateTime))
    driver_kind: str | None = None
    executor_snapshot_json: dict[str, object] | None = Field(
        default=None, sa_column=Column(JSON)
    )
    completion_id: str | None = Field(default=None, unique=True)
    completion_sha256: str | None = None
    exit_code: int | None = None
    failure_kind: str | None = None
    error_message: str | None = None
    stdout_tail: str | None = Field(default=None, sa_column=Column(Text))
    stderr_tail: str | None = Field(default=None, sa_column=Column(Text))
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now(), onupdate=func.now()),
    )


class GithubConnectionDB(SQLModel, table=True):
    """Per-project GitHub OAuth connection.

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
# OTel-Native Tracing — Canonical OTLP span store + durable inbox
# ============================================================================


class ApiKeyDailyUsageDB(SQLModel, table=True):
    """Per-key daily ingest usage. One row per (key, UTC day),
    UPSERT-incremented at accept time by the ingest routes. Tiny rows;
    reaped by the maintenance pass past APO_USAGE_RETENTION_DAYS."""

    __tablename__: ClassVar[str] = "api_key_daily_usage"

    api_key_id: str = Field(foreign_key="api_keys.id", primary_key=True)
    day: str = Field(primary_key=True)  # "YYYY-MM-DD" (UTC)
    span_count: int = Field(default=0)
    byte_count: int = Field(default=0)
    request_count: int = Field(default=0)
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )


class OtlpIngestBatchDB(SQLModel, table=True):
    """Durable inbox record for a received OTLP batch.

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
    # Audit linkage: which key accepted this batch and how big it
    # was on the wire. Usage accounting happens route-side; these make the
    # history reconstructable straight from the inbox.
    api_key_id: str | None = Field(default=None, index=True)
    payload_bytes: int = Field(default=0)


class OtlpSpanDB(SQLModel, table=True):
    """Canonical lossless OTel span store.

    One row per ``(project_id, trace_id, span_id)`` — the immutable source of
    truth and the single home of span data. Typed OTel values are retained as
    JSON for replayability (see ``span_row_to_otlp_json`` in the receiver for
    the inverse direction). Not preserved at any level — no column, no reader:
    OTLP dropped-attribute/event/link counters, ``schemaUrl``, and
    sub-microsecond timestamp bits.
    """

    __tablename__: ClassVar[str] = "otlp_spans"
    __table_args__ = (
        UniqueConstraint("project_id", "trace_id", "span_id", name="uq_otlp_span"),
        Index("ix_otlp_spans_trace", "project_id", "trace_id"),
        # The hottest trace-search filters — service and operation
        # facets/filters over the single span home. trace_id trails both so
        # span_field_facets' per-trace DISTINCT count is an index-only scan.
        Index("ix_otlp_spans_service", "project_id", "service_name", "trace_id"),
        Index("ix_otlp_spans_operation", "project_id", "span_name", "trace_id"),
        # The facets' time window filters on start_time; without this index
        # the window reads the whole project's spans anyway.
        Index("ix_otlp_spans_start", "project_id", "start_time"),
    )

    id: int | None = Field(default=None, primary_key=True)
    project_id: str = Field(index=True)
    trace_id: str = Field(index=True)
    span_id: str = Field(index=True)
    parent_span_id: str | None = Field(default=None, index=True)
    start_time: datetime | None = Field(default=None, sa_column=Column(UTCDateTime))
    end_time: datetime | None = Field(default=None, sa_column=Column(UTCDateTime))
    span_name: str = Field(default="")
    # Materialized from resource.attributes["service.name"] at ingest —
    # the hottest company-wide filter. NULL on legacy rows
    # without a derivable service.
    service_name: str | None = Field(default=None)
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

    content_policy: str = Field(default="default")
    projection_version: int = Field(default=0)

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(UTCDateTime, server_default=func.now()),
    )


class InstallationStateDB(SQLModel, table=True):
    """Singleton durable state for one Self-Hosted Installation.

    ``id`` has exactly one supported value: ``"installation"``. The singleton
    records whether Installation Initialization has occurred, independent of
    the current User count. Deleting all Users does not reopen setup; only an
    explicit full database reset clears the singleton.
    """

    __tablename__: ClassVar[str] = "installation_state"

    id: str = Field(primary_key=True, default="installation")
    initialized_at: datetime | None = Field(default=None)
    initial_user_id: str | None = Field(default=None)
