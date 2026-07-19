"""Project task inventory service (SPEC-119).

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
from .paths import DEMO_TASK_ROOT


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
    that carry the new provenance snapshot. Returns the new rows.

    Caller is responsible for committing any status transitions on the
    source row itself.
    """
    existing = session.exec(
        select(ProjectTaskInventoryDB).where(
            ProjectTaskInventoryDB.project == project_id,
            ProjectTaskInventoryDB.task_source_id == source.id,
        )
    ).all()
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
        session.add(row)
        new_rows.append(row)

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
        has_user_simulator=task.has_user_simulator,
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
        has_user_simulator=row.has_user_simulator,
        tags=list(row.tags_json) if row.tags_json else [],
        run_stats=None,
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
        has_user_simulator=row.has_user_simulator,
        tags=list(row.tags_json) if row.tags_json else [],
        latest_run=None,
        run_stats=None,
    )


def seed_demo_inventory(
    session: Session, source: ProjectTaskSourceDB
) -> list[ProjectTaskInventoryDB]:
    """Populate inventory for a freshly-created demo source.

    Runs the legacy demo discovery against the bundled example-service
    workspace and writes rows without touching the sync state machine
    (the demo source is already ``ready`` by the time this is called).
    """
    discovered = discover_agent_tasks(DEMO_TASK_ROOT)
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
