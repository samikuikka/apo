"""Cascade deletion for projects (issue #14).

``DELETE /v1/projects/{id}`` 500'd with ``FOREIGN KEY constraint failed``
because ``delete_project`` called ``session.delete(project)`` with no
dependent cleanup, and production runs with ``PRAGMA foreign_keys=ON``.
Every project has at least an owner ``ProjectMembershipDB`` row (a hard FK
to ``projects.id``), so the parent delete was always rejected.

This module owns the full dependent cleanup so both ``delete_project`` (full
delete) and ``reset_project_data`` (clear observation data, keep the project
+ API keys) share one source of truth. The dependent set will keep growing
as new tables land — centralizing it here is what keeps the two endpoints
from drifting.

Why explicit deletes over ``ondelete="CASCADE"``:

- SQLite cannot ``ALTER`` an existing table to add cascade — it only takes
  effect at table *creation*, so deployed databases would need a
  table-rebuild migration. Explicit deletes work on any schema.
- Cascade only covers the five hard-FK tables. The fourteen soft-reference
  tables (``project: str = Field(index=True)``, no FK) would orphan
  regardless. Explicit delete cleans both.
- The codebase already used this pattern (the old ``reset_project_data``
  did per-table deletes inline).

Deletion order matters: transitive children (rows that FK to a
project-scoped table, not to ``projects`` directly) must go before their
parent rows, and inventory must go before its task source. Ordering within
each tier is otherwise arbitrary.
"""

# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

from __future__ import annotations

from typing import Any

from sqlmodel import Session, select

from ..models.db import (
    AdaptiveTaskStateDB,
    AgentTaskBatchRunDB,
    AgentTaskCheckReportDB,
    AgentTaskDeliverableDB,
    AgentTaskJudgmentDB,
    AgentTaskTestResultCorrectionDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    AgentTaskScheduleOccurrenceDB,
    ApiKeyDB,
    ApiKeyDailyUsageDB,
    ArchivedModelDB,
    CallMetricDB,
    CommentDB,
    CommentReactionDB,
    ExecutorDB,
    ExecutorEnrollmentTokenDB,
    ExecutorPoolDB,
    GithubConnectionDB,
    LoggedCallDB,
    OtlpIngestBatchDB,
    OtlpSpanDB,
    ProjectDB,
    ProjectInvitationDB,
    ProjectMembershipDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    RunDB,
    RunMetricDB,
    ScoreConfigDB,
    SessionDB,
    TaskExecutionAttemptDB,
    TaskDefinitionRevisionDB,
    TaskRevisionDB,
    TaskViewComparisonDB,
    TaskViewDB,
    WebhookDB,
)
from ..models.pricing import ModelRowDB


def delete_project_data(
    session: Session,
    project_id: str,
    *,
    keep_project: bool,
    keep_api_keys: bool,
) -> dict[str, int]:
    """Delete a project's dependents, and optionally the project row itself.

    Parameters
    ----------
    keep_project:
        When ``True``, the ``ProjectDB`` row and its membership / invitation /
        task-source / github-connection rows survive (the ``reset-data``
        semantics — clear observation data, keep the project shell). When
        ``False`` (the ``delete_project`` path), everything goes including
        the project row.
    keep_api_keys:
        When ``True``, ``ApiKeyDB`` rows for the project survive. The reset
        path keeps them so a project being cleared doesn't lock out its
        integrations; the delete path removes them since the project is gone.

    Returns a ``{table: deleted_count}`` map so callers can report what was
    removed. Commits once at the end (matches the prior inline handler).
    """
    deleted: dict[str, int] = {}

    # Task Revision bundle objects are removed by the async route
    # (delete_task_revision_bundles_for_project) BEFORE this sync function runs,
    # while their keys are still resolvable. Here we only drop relational rows.

    # --- Transitive children: FK to a project-scoped table, not to projects.
    # These must precede their parent rows so no FK is left dangling mid-delete.
    deleted["comment_reactions"] = _delete_transitive(
        session,
        CommentReactionDB,
        CommentReactionDB.comment_id,
        select(CommentDB.id).where(CommentDB.project_id == project_id),
    )
    deleted["adaptive_task_states"] = _delete_transitive(
        session,
        AdaptiveTaskStateDB,
        AdaptiveTaskStateDB.schedule_id,
        select(AgentTaskScheduleDB.id).where(
            AgentTaskScheduleDB.project == project_id
        ),
    )
    # Schedule occurrences are transitive through schedules.
    deleted["schedule_occurrences"] = _delete_transitive(
        session,
        AgentTaskScheduleOccurrenceDB,
        AgentTaskScheduleOccurrenceDB.schedule_id,
        select(AgentTaskScheduleDB.id).where(
            AgentTaskScheduleDB.project == project_id
        ),
    )
    # Attempts must be deleted BEFORE their parent task runs
    # (task_execution_attempts.task_run_id → agent_task_runs.id).
    # Previously runs were deleted first, which FK-violated on attempts.
    deleted["task_execution_attempts"] = _delete_by_column(
        session, TaskExecutionAttemptDB, TaskExecutionAttemptDB.project == project_id
    )
    # Check reports are transitive through task runs
    # (FK CASCADE, but explicit delete works on schemas where the FK was
    # added after table creation).
    deleted["agent_task_check_reports"] = _delete_transitive(
        session,
        AgentTaskCheckReportDB,
        AgentTaskCheckReportDB.run_id,
        select(AgentTaskRunDB.id).join(AgentTaskBatchRunDB).where(
            AgentTaskBatchRunDB.project == project_id
        ),
    )
    deleted["agent_task_judgments"] = _delete_by_column(
        session, AgentTaskJudgmentDB, AgentTaskJudgmentDB.project == project_id
    )
    # Corrections are project-scoped like judgments, but also FK
    # agent_task_runs — delete before the runs go.
    deleted["agent_task_test_result_corrections"] = _delete_transitive(
        session,
        AgentTaskTestResultCorrectionDB,
        AgentTaskTestResultCorrectionDB.task_run_id,
        select(AgentTaskRunDB.id).join(AgentTaskBatchRunDB).where(
            AgentTaskBatchRunDB.project == project_id
        ),
    )
    # Deliverables are direct (have a ``project`` column) but FK
    # agent_task_runs, so they must be deleted before runs. Their stored
    # objects are cleaned up by the async route pre-pass.
    deleted["agent_task_deliverables"] = _delete_by_column(
        session, AgentTaskDeliverableDB, AgentTaskDeliverableDB.project == project_id
    )
    deleted["agent_task_runs"] = _delete_transitive(
        session,
        AgentTaskRunDB,
        AgentTaskRunDB.batch_run_id,
        select(AgentTaskBatchRunDB.id).where(
            AgentTaskBatchRunDB.project == project_id
        ),
    )

    # --- Direct soft references (``project`` / ``project_id`` column, no FK).
    # These don't block the project delete but would orphan if left behind.
    deleted["run_metrics"] = _delete_by_column(
        session, RunMetricDB, RunMetricDB.project == project_id
    )
    deleted["call_metrics"] = _delete_by_column(
        session, CallMetricDB, CallMetricDB.project == project_id
    )
    deleted["logged_calls"] = _delete_by_column(
        session, LoggedCallDB, LoggedCallDB.project == project_id
    )
    deleted["runs"] = _delete_by_column(
        session, RunDB, RunDB.project == project_id
    )
    deleted["otlp_spans"] = _delete_by_column(
        session, OtlpSpanDB, OtlpSpanDB.project_id == project_id
    )
    deleted["otlp_ingest_batches"] = _delete_by_column(
        session, OtlpIngestBatchDB, OtlpIngestBatchDB.project_id == project_id
    )
    deleted["score_configs"] = _delete_by_column(
        session, ScoreConfigDB, ScoreConfigDB.project == project_id
    )
    deleted["webhooks"] = _delete_by_column(
        session, WebhookDB, WebhookDB.project == project_id
    )
    deleted["comments"] = _delete_by_column(
        session, CommentDB, CommentDB.project_id == project_id
    )
    deleted["sessions"] = _delete_by_column(
        session, SessionDB, SessionDB.project == project_id
    )
    # Saved Task Views and Task View Comparisons.
    deleted["task_views"] = _delete_by_column(
        session, TaskViewDB, TaskViewDB.project_id == project_id
    )
    deleted["task_view_comparisons"] = _delete_by_column(
        session, TaskViewComparisonDB, TaskViewComparisonDB.project_id == project_id
    )
    # task_revisions reference batch runs via FK, so they must be
    # removed BEFORE agent_task_batch_runs. Their bundle objects were already
    # removed above. Guarded for pre-v12 DBs.
    try:
        deleted["task_revisions"] = _delete_by_column(
            session, TaskRevisionDB, TaskRevisionDB.project == project_id
        )
    except Exception:
        deleted["task_revisions"] = 0
    deleted["agent_task_batch_runs"] = _delete_by_column(
        session, AgentTaskBatchRunDB, AgentTaskBatchRunDB.project == project_id
    )
    # Task_definition_revisions FK projects, and
    # agent_task_runs.task_definition_revision_id FKs them. Runs are already
    # gone above, so this is safe.
    deleted["task_definition_revisions"] = _delete_by_column(
        session, TaskDefinitionRevisionDB, TaskDefinitionRevisionDB.project == project_id
    )
    deleted["agent_task_schedules"] = _delete_by_column(
        session, AgentTaskScheduleDB, AgentTaskScheduleDB.project == project_id
    )
    # executor enrollment tokens, executors, then pools (pools are
    # referenced by executors/tokens, so they go last of the three).
    try:
        deleted["executor_enrollment_tokens"] = _delete_by_column(
            session, ExecutorEnrollmentTokenDB, ExecutorEnrollmentTokenDB.project == project_id
        )
        deleted["executors"] = _delete_by_column(
            session, ExecutorDB, ExecutorDB.project == project_id
        )
        deleted["executor_pools"] = _delete_by_column(
            session, ExecutorPoolDB, ExecutorPoolDB.project == project_id
        )
    except Exception:
        deleted.setdefault("executor_enrollment_tokens", 0)
        deleted.setdefault("executors", 0)
        deleted.setdefault("executor_pools", 0)
    # per-project model pricing rows (never __global__; globals are
    # owned by the bundled JSON). Cascading FKs remove the tiers/prices.
    deleted["models"] = _delete_by_column(
        session,
        ModelRowDB,
        ModelRowDB.project == project_id,
    )
    if not keep_api_keys:
        # Daily ingest-usage rows FK api_keys.id and carry no project column;
        # they must go before the keys themselves or the flush fails on the FK.
        deleted["api_key_daily_usage"] = _delete_transitive(
            session,
            ApiKeyDailyUsageDB,
            ApiKeyDailyUsageDB.api_key_id,
            select(ApiKeyDB.id).where(ApiKeyDB.project == project_id),
        )
        deleted["api_keys"] = _delete_by_column(
            session, ApiKeyDB, ApiKeyDB.project == project_id
        )

    # --- Hard FKs to projects.id. These are what blocked the bare delete.
    # Inventory before its task source (inventory FKs the source). The
    # membership / invitation / source / github rows only get cleared on a
    # full project delete — reset-data keeps the project shell intact.
    if not keep_project:
        deleted["project_task_inventory"] = _delete_by_column(
            session,
            ProjectTaskInventoryDB,
            ProjectTaskInventoryDB.project == project_id,
        )
        deleted["project_task_sources"] = _delete_by_column(
            session,
            ProjectTaskSourceDB,
            ProjectTaskSourceDB.project == project_id,
        )
        deleted["project_invitations"] = _delete_by_column(
            session,
            ProjectInvitationDB,
            ProjectInvitationDB.project_id == project_id,
        )
        # Archived-model choices survive reset-data: they describe the
        # project's model vocabulary, not its observation data.
        deleted["archived_models"] = _delete_by_column(
            session,
            ArchivedModelDB,
            ArchivedModelDB.project_id == project_id,
        )
        deleted["github_connections"] = _delete_by_column(
            session,
            GithubConnectionDB,
            GithubConnectionDB.project == project_id,
        )
        deleted["project_memberships"] = _delete_by_column(
            session,
            ProjectMembershipDB,
            ProjectMembershipDB.project_id == project_id,
        )

        # Flush the dependent deletes before removing the project row. Without
        # this, SQLAlchemy's unit-of-work batches all pending deletes and may
        # issue ``DELETE FROM projects`` before the child ``DELETE``s, which
        # trips ``PRAGMA foreign_keys=ON`` (issue #14). Flushing forces the
        # child rows out first so the parent delete sees no references left.
        session.flush()

        project = session.get(ProjectDB, project_id)
        if project is not None:
            session.delete(project)

    session.commit()
    # Drop zero-count entries so the response only mentions touched tables —
    # keeps the reset-data output readable for projects that have no schedules,
    # no webhooks, etc.
    return {table: count for table, count in deleted.items() if count}


def _delete_by_column(
    session: Session, model: type[Any], where_clause: Any
) -> int:
    """Delete every row of ``model`` matching ``where_clause`` and return the count.

    ``where_clause`` is a SQLAlchemy boolean expression (e.g.
    ``RunDB.project == project_id``). Typed as ``Any`` because SQLModel's
    column attributes don't narrow to a single ``ColumnElement[bool]``
    without per-call casts — the runtime contract is straightforward.
    """
    rows = list(session.exec(select(model).where(where_clause)).all())
    for row in rows:
        session.delete(row)
    return len(rows)


def _delete_transitive(
    session: Session,
    model: type[Any],
    fk_column: Any,
    parent_ids_query: Any,
) -> int:
    """Delete rows of ``model`` whose ``fk_column`` matches any parent id.

    For transitive dependents (e.g. ``AgentTaskRunDB.batch_run_id`` →
    ``AgentTaskBatchRunDB.id``): resolve the parent ids for this project,
    then delete the children that reference them. Returns the child count.

    ``fk_column`` and ``parent_ids_query`` are typed ``Any`` because SQLModel
    column attributes and ``select()`` results don't narrow to the concrete
    SQLAlchemy generic types without per-call casts.
    """
    parent_ids = list(session.exec(parent_ids_query).all())
    if not parent_ids:
        return 0
    rows = list(
        session.exec(select(model).where(fk_column.in_(parent_ids))).all()
    )
    for row in rows:
        session.delete(row)
    return len(rows)


__all__ = ["delete_project_data"]
