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

from __future__ import annotations

from typing import Any

from sqlmodel import Session, select

from ..models.db import (
    AdaptiveTaskStateDB,
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    AnnotationQueueDB,
    ApiKeyDB,
    CallMetricDB,
    CommentDB,
    CommentReactionDB,
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
    deleted["annotation_queues"] = _delete_by_column(
        session, AnnotationQueueDB, AnnotationQueueDB.project == project_id
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
    deleted["agent_task_batch_runs"] = _delete_by_column(
        session, AgentTaskBatchRunDB, AgentTaskBatchRunDB.project == project_id
    )
    deleted["agent_task_schedules"] = _delete_by_column(
        session, AgentTaskScheduleDB, AgentTaskScheduleDB.project == project_id
    )
    # SPEC-136: per-project model pricing rows (never __global__; globals are
    # owned by the bundled JSON). Cascading FKs remove the tiers/prices.
    deleted["models"] = _delete_by_column(
        session,
        ModelRowDB,
        ModelRowDB.project == project_id,
    )
    if not keep_api_keys:
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
    session: Session, model: type[Any], where_clause: Any  # pyright: ignore[reportExplicitAny, reportAny]
) -> int:
    """Delete every row of ``model`` matching ``where_clause`` and return the count.

    ``where_clause`` is a SQLAlchemy boolean expression (e.g.
    ``RunDB.project == project_id``). Typed as ``Any`` because SQLModel's
    column attributes don't narrow to a single ``ColumnElement[bool]``
    without per-call casts — the runtime contract is straightforward.
    """
    rows = list(session.exec(select(model).where(where_clause)).all())  # pyright: ignore[reportAny]
    for row in rows:
        session.delete(row)
    return len(rows)


def _delete_transitive(
    session: Session,
    model: type[Any],
    fk_column: Any,  # pyright: ignore[reportExplicitAny, reportAny]
    parent_ids_query: Any,  # pyright: ignore[reportExplicitAny, reportAny]
) -> int:
    """Delete rows of ``model`` whose ``fk_column`` matches any parent id.

    For transitive dependents (e.g. ``AgentTaskRunDB.batch_run_id`` →
    ``AgentTaskBatchRunDB.id``): resolve the parent ids for this project,
    then delete the children that reference them. Returns the child count.

    ``fk_column`` and ``parent_ids_query`` are typed ``Any`` because SQLModel
    column attributes and ``select()`` results don't narrow to the concrete
    SQLAlchemy generic types without per-call casts.
    """
    parent_ids = list(session.exec(parent_ids_query).all())  # pyright: ignore[reportAny]
    if not parent_ids:
        return 0
    rows = list(
        session.exec(select(model).where(fk_column.in_(parent_ids))).all()  # pyright: ignore[reportAny]
    )
    for row in rows:
        session.delete(row)
    return len(rows)


__all__ = ["delete_project_data"]
