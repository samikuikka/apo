"""Task lifecycle events — the server's observation record.

When a task leaves the published catalog, a ``removed`` tombstone preserves
its last-known metadata so the task stays findable (the Archived view, the
task-detail fallback) together with the runs that outlive it. Events are
derived observations, never state to mutate: the moment a task reappears in
the catalog its event is deleted and the task is active again.

Written from the two inventory replacement chokepoints (catalog publication
and task-source sync) next to ``handle_tasks_removed_from_catalog``.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import and_
from sqlmodel import Session, col, delete, select

from ..models.db import AgentTaskRunDB, TaskLifecycleEventDB


def record_removals(
    session: Session,
    *,
    project_id: str,
    removed: dict[str, dict[str, str]],
    source_commit_sha: str | None = None,
) -> None:
    """Upsert one ``removed`` event per task that left the catalog.

    ``removed`` maps ``task_id -> {display_name, folder_path, task_path}``
    — the metadata snapshot from the last inventory row before the replace.
    ``run_count`` is computed here so the tombstone records exactly what
    the removal retained. Does not commit — the caller owns the transaction
    (same contract as ``handle_tasks_removed_from_catalog``).
    """
    if not removed:
        return

    now = datetime.now(timezone.utc)
    run_counts = _run_counts(session, project_id, list(removed))

    existing = session.exec(
        select(TaskLifecycleEventDB).where(
            TaskLifecycleEventDB.project == project_id,
            col(TaskLifecycleEventDB.task_id).in_(list(removed)),
        )
    ).all()
    prior_by_task = {row.task_id: row for row in existing}

    for task_id, meta in removed.items():
        prior = prior_by_task.get(task_id)
        if prior is not None:
            prior.display_name = meta["display_name"]
            prior.folder_path = meta["folder_path"]
            prior.task_path = meta["task_path"]
            prior.source_commit_sha = source_commit_sha or prior.source_commit_sha
            prior.detected_at = now
            prior.run_count = run_counts.get(task_id, 0)
            session.add(prior)
        else:
            session.add(
                TaskLifecycleEventDB(
                    project=project_id,
                    task_id=task_id,
                    event="removed",
                    display_name=meta["display_name"],
                    folder_path=meta["folder_path"],
                    task_path=meta["task_path"],
                    source_commit_sha=source_commit_sha,
                    detected_at=now,
                    run_count=run_counts.get(task_id, 0),
                )
            )


def clear_events_for_returned_tasks(
    session: Session, *, project_id: str, present_task_ids: set[str]
) -> None:
    """Delete events for tasks that are back in the catalog.

    A returned task is active again — the tombstone would otherwise lie
    about a removal that has been undone. Its prior runs reattach through
    the shared string ``task_id`` on the runs. Does not commit.
    """
    if not present_task_ids:
        return
    _ = session.exec(
        delete(TaskLifecycleEventDB).where(
            and_(
                col(TaskLifecycleEventDB.project) == project_id,
                col(TaskLifecycleEventDB.task_id).in_(list(present_task_ids)),
            )
        )
    )


def list_removed_events(
    session: Session, project_id: str
) -> list[TaskLifecycleEventDB]:
    """All open ``removed`` events for a project, oldest removal first."""
    rows = session.exec(
        select(TaskLifecycleEventDB)
        .where(
            TaskLifecycleEventDB.project == project_id,
            TaskLifecycleEventDB.event == "removed",
        )
        .order_by(col(TaskLifecycleEventDB.detected_at))
    ).all()
    return list(rows)


def get_removed_event(
    session: Session, *, project_id: str, task_id: str
) -> TaskLifecycleEventDB | None:
    """The open ``removed`` event for one task, if any."""
    return session.exec(
        select(TaskLifecycleEventDB).where(
            TaskLifecycleEventDB.project == project_id,
            TaskLifecycleEventDB.task_id == task_id,
            TaskLifecycleEventDB.event == "removed",
        )
    ).first()


def _run_counts(
    session: Session, project_id: str, task_ids: list[str]
) -> dict[str, int]:
    """Count retained runs per task in one grouped query.

    Project scoping goes through the parent batch run (runs carry no
    project column) so two projects' runs never mix even when they share
    a task id — the same contract as ``runs_in_view``.
    """
    from sqlalchemy import func

    from ..models.db import AgentTaskBatchRunDB

    rows = session.exec(
        select(AgentTaskRunDB.task_id, func.count())
        .join(
            AgentTaskBatchRunDB,
            and_(
                col(AgentTaskBatchRunDB.id) == AgentTaskRunDB.batch_run_id,
                col(AgentTaskBatchRunDB.project) == project_id,
            ),
        )
        .where(col(AgentTaskRunDB.task_id).in_(task_ids))
        .group_by(AgentTaskRunDB.task_id)
    ).all()
    return {task_id: count for task_id, count in rows}


__all__ = [
    "clear_events_for_returned_tasks",
    "get_removed_event",
    "list_removed_events",
    "record_removals",
]
