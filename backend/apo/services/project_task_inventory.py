"""Project task inventory service.

Owns the persisted task inventory table that backs the project-scoped
``/v1/projects/{id}/agent-tasks`` routes. Inventory is the source of
truth for "what tasks exist" on a project once its task source has been
synced; the live filesystem scan in ``agent_task_discovery`` is now an
internal detail used only during sync.

Key behaviours:

- Inventory rows are replaced in-place on every successful sync. Stale
  rows from older commits are removed so callers always see the latest
  snapshot.
- Rows carry their own provenance (source type, ref, resolved commit
  SHA, subpath) so historical runs can be explained even after the
  source moves on.
- Historical ``AgentTaskRunDB`` rows do not depend on these rows
  staying current — they snapshot the inventory id and commit SHA at
  creation time, so a task disappearing from inventory never breaks an
  old run.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timezone

from sqlmodel import Session, select

from ..models.db import ProjectTaskInventoryDB, ProjectTaskSourceDB
from ..models.schemas import AgentTaskDetail, AgentTaskRunStats, AgentTaskSummary
from .agent_task_discovery import DiscoveredAgentTask, discover_agent_tasks


def list_inventory_for_project(
    session: Session,
    project_id: str,
    *,
    grep: str | None = None,
) -> list[ProjectTaskInventoryDB]:
    """Return inventory rows for a project, optionally filtered by grep.

    Matches ``grep`` case-insensitively against ``task_id``,
    ``display_name``, or ``folder_path``.
    """
    statement = select(ProjectTaskInventoryDB).where(
        ProjectTaskInventoryDB.project == project_id
    )
    rows = session.exec(statement).all()
    if not grep:
        return list(rows)
    needle = grep.lower()
    return [
        row
        for row in rows
        if needle in row.task_id.lower()
        or needle in row.display_name.lower()
        or needle in (row.folder_path or "").lower()
    ]


def get_inventory_row(
    session: Session, project_id: str, task_id: str
) -> ProjectTaskInventoryDB | None:
    """Return the inventory row for ``task_id`` on ``project_id``."""
    statement = (
        select(ProjectTaskInventoryDB)
        .where(
            ProjectTaskInventoryDB.project == project_id,
            ProjectTaskInventoryDB.task_id == task_id,
        )
        .limit(1)
    )
    return session.exec(statement).first()


def replace_inventory(
    session: Session,
    *,
    project_id: str,
    source: ProjectTaskSourceDB,
    discovered: Iterable[DiscoveredAgentTask],
    resolved_commit_sha: str | None,
) -> list[ProjectTaskInventoryDB]:
    """Atomically replace the project's inventory with ``discovered``.

    Implements behaviour #5 ("sync is replace-in-place"): all existing
    rows for the project/source are deleted, then fresh rows are written
    that carry the new provenance snapshot. Adaptive scheduling state for
    tasks that left the snapshot is pruned (a schedule's ``next_run_at``
    is the min over its states, so an orphaned state would keep the
    schedule firing into empty selections or stall it). Returns the new
    rows.

    Caller is responsible for committing any status transitions on the
    source row itself.
    """
    existing = session.exec(
        select(ProjectTaskInventoryDB).where(
            ProjectTaskInventoryDB.project == project_id,
            ProjectTaskInventoryDB.task_source_id == source.id,
        )
    ).all()
    removed = {
        row.task_id: row.task_path or "" for row in existing
    }
    # First-seen provenance survives the replace keyed by task_id (issue #444):
    # a re-sync of an unchanged source must not reset a task's first appearance.
    prior = {row.task_id: row for row in existing}
    for row in existing:
        session.delete(row)
    session.flush()

    now = datetime.now(timezone.utc)
    new_rows: list[ProjectTaskInventoryDB] = []
    for task in discovered:
        row = _build_inventory_row(
            project_id=project_id,
            source=source,
            task=task,
            resolved_commit_sha=resolved_commit_sha,
            discovered_at=now,
        )
        prev = prior.get(task.id)
        if prev is not None:
            row.first_published_at = prev.first_published_at or now
            row.first_published_by_user_id = prev.first_published_by_user_id
            row.git_author_name = prev.git_author_name
            row.git_author_email = prev.git_author_email
            row.git_first_commit_at = prev.git_first_commit_at
            row.git_first_commit_sha = prev.git_first_commit_sha
            row.description = prev.description
        session.add(row)
        new_rows.append(row)

    surviving_ids = {row.task_id for row in new_rows}
    removed = {
        task_id: task_path
        for task_id, task_path in removed.items()
        if task_id not in surviving_ids
    }

    session.commit()
    if removed:
        from .adaptive_scheduler import handle_tasks_removed_from_catalog

        _ = handle_tasks_removed_from_catalog(
            session, project_id=project_id, removed=removed
        )
        session.commit()
    for row in new_rows:
        session.refresh(row)
    return new_rows


def _build_inventory_row(
    *,
    project_id: str,
    source: ProjectTaskSourceDB,
    task: DiscoveredAgentTask,
    resolved_commit_sha: str | None,
    discovered_at: datetime,
) -> ProjectTaskInventoryDB:
    """Map a discovered filesystem task into a persisted inventory row."""
    return ProjectTaskInventoryDB(
        project=project_id,
        task_source_id=source.id,
        task_id=task.id,
        display_name=task.display_name,
        adapter_name=task.adapter_name,
        folder_path=task.folder_path,
        task_path=task.task_path,
        has_checks=task.has_checks,
        tags_json=list(task.tags) if task.tags else None,
        source_type=source.source_type,
        source_ref=_source_ref(source),
        source_commit_sha=resolved_commit_sha,
        source_subpath=source.subpath,
        discovered_at=discovered_at,
    )


def _source_ref(source: ProjectTaskSourceDB) -> str | None:
    """Resolve the human-readable ref to record on inventory rows."""
    if source.source_type == "git":
        return source.git_ref
    if source.source_type == "filesystem":
        return source.filesystem_path
    if source.source_type == "demo":
        return source.demo_seed_id
    return None


def task_source_inventory_is_stale(
    session: Session,
    source: ProjectTaskSourceDB,
) -> bool:
    """Return whether persisted inventory no longer matches the source config.

    Inventory rows are replaced atomically on sync, so sampling a single
    row is enough to detect whether the current source identity differs
    from the last synced snapshot. A source with no inventory rows is
    treated as not stale here; callers can handle the "no tasks yet"
    case separately.
    """
    row = session.exec(
        select(ProjectTaskInventoryDB)
        .where(
            ProjectTaskInventoryDB.project == source.project,
            ProjectTaskInventoryDB.task_source_id == source.id,
        )
        .limit(1)
    ).first()
    if row is None:
        return False

    return (
        row.source_type != source.source_type
        or row.source_ref != _source_ref(source)
        or row.source_subpath != source.subpath
    )


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------


def to_summary(row: ProjectTaskInventoryDB) -> AgentTaskSummary:
    """Convert an inventory row into the public ``AgentTaskSummary`` shape.

    ``run_stats`` is left ``None`` here; the project-scoped route
    attaches stats separately so this helper stays a pure transform.
    """
    return AgentTaskSummary(
        id=row.task_id,
        task_path=row.task_path,
        folder_path=row.folder_path,
        display_name=row.display_name,
        adapter_name=row.adapter_name or "unknown",
        has_checks=row.has_checks,
        tags=list(row.tags_json) if row.tags_json else [],
        run_stats=None,
        description=row.description,
        first_published_at=row.first_published_at,
        first_published_by_user_id=row.first_published_by_user_id,
        git_author_name=row.git_author_name,
        git_author_email=row.git_author_email,
        git_first_commit_at=row.git_first_commit_at,
        git_first_commit_sha=row.git_first_commit_sha,
    )


def to_detail(row: ProjectTaskInventoryDB) -> AgentTaskDetail:
    """Convert an inventory row into the public ``AgentTaskDetail`` shape.

    Both ``latest_run`` and ``run_stats`` are left ``None`` here; the
    project-scoped route enriches them separately.
    """
    return AgentTaskDetail(
        id=row.task_id,
        task_path=row.task_path,
        folder_path=row.folder_path,
        display_name=row.display_name,
        adapter_name=row.adapter_name or "unknown",
        has_checks=row.has_checks,
        tags=list(row.tags_json) if row.tags_json else [],
        latest_run=None,
        run_stats=None,
        description=row.description,
        first_published_at=row.first_published_at,
        first_published_by_user_id=row.first_published_by_user_id,
        git_author_name=row.git_author_name,
        git_author_email=row.git_author_email,
        git_first_commit_at=row.git_first_commit_at,
        git_first_commit_sha=row.git_first_commit_sha,
    )


def attach_publisher_labels(
    session: Session,
    tasks: "list[AgentTaskSummary] | list[AgentTaskDetail]",
) -> None:
    """Resolve ``first_published_by_user_id`` into a human-readable label.

    Mutates in place (the same shape as the route-side ``run_stats``
    enrichment): name when the user set one, else email. Unknown ids keep
    ``None`` — a deleted publisher is silence, not an error.
    """
    from sqlmodel import col

    from ..models.db import UserDB

    ids = {t.first_published_by_user_id for t in tasks if t.first_published_by_user_id}
    if not ids:
        return
    users = session.exec(select(UserDB).where(col(UserDB.id).in_(ids))).all()
    labels = {u.id: (u.name or u.email) for u in users}
    for t in tasks:
        if t.first_published_by_user_id:
            t.first_published_by = labels.get(t.first_published_by_user_id)


def seed_demo_inventory(
    session: Session, source: ProjectTaskSourceDB
) -> list[ProjectTaskInventoryDB]:
    """Populate inventory for a freshly-created demo source.

    Runs the legacy demo discovery against the bundled example-service
    workspace and writes rows without touching the sync state machine
    (the demo source is already ``ready`` by the time this is called).

    Uses the env-aware ``demo_task_root()``: container images bundle the demo
    tree at a path the source-tree-relative ``DEMO_TASK_ROOT`` constant can't
    see, which silently seeded an empty inventory.
    """
    from .paths import demo_task_root

    discovered = discover_agent_tasks(demo_task_root())
    return replace_inventory(
        session,
        project_id=source.project,
        source=source,
        discovered=discovered,
        resolved_commit_sha=None,
    )


__all__ = [
    "AgentTaskDetail",
    "AgentTaskRunStats",
    "AgentTaskSummary",
    "get_inventory_row",
    "list_inventory_for_project",
    "replace_inventory",
    "seed_demo_inventory",
    "task_source_inventory_is_stale",
    "to_detail",
    "to_summary",
]
