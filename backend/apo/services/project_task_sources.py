"""Project task source service.

Encapsulates reading, validating, and mutating a project's task source
configuration. The task source determines where a project's task
inventory comes from, replacing the previous process-global fallback to
``apps/example-service/e2e``.

Behavioural contract:

- Each project owns at most one task source row (``project`` is unique).
- New projects start without a row; ``get_task_source`` returns ``None``
  and the API serializes that as ``null``.
- The demo project is seeded with a ``demo`` source row so it does not
  depend on the legacy filesystem fallback.
- Switching source type clears irrelevant fields so callers never see
  stale data from a previous mode (e.g. ``git_ref`` on a ``demo``
  source).
- Runtime-affecting source changes transition status to
  ``pending_sync``; display-name-only edits preserve the existing sync
  state so a rename does not invalidate inventory.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Final

from sqlmodel import Session, select

from ..models.db import ProjectTaskSourceDB
from ..models.schemas import ProjectTaskSource

DEMO_PROJECT_ID: Final[str] = "demo"

VALID_SOURCE_TYPES: Final[frozenset[str]] = frozenset({"git", "filesystem", "demo"})

# Status values used across the task source lifecycle. ``syncing`` is
# included so the sync state machine (and the temporary sync stub) can mark a source
# mid-flight without colliding with the persistent end states.
VALID_STATUSES: Final[frozenset[str]] = frozenset(
    {"unconfigured", "pending_sync", "syncing", "ready", "error"}
)


def get_task_source_db(session: Session, project_id: str) -> ProjectTaskSourceDB | None:
    """Return the project's task source row, or ``None`` if unconfigured."""
    statement = select(ProjectTaskSourceDB).where(
        ProjectTaskSourceDB.project == project_id
    )
    return session.exec(statement).first()


def serialize(
    task_source: ProjectTaskSourceDB | None,
    *,
    session: Session | None = None,
) -> ProjectTaskSource | None:
    """Convert a ``ProjectTaskSourceDB`` row into its API schema.

    Returns ``None`` so callers can ``return serialize(row)`` directly
    whether or not the project has been configured yet.
    """
    if task_source is None:
        return None
    inventory_stale = False
    if session is not None:
        from .project_task_inventory import task_source_inventory_is_stale

        inventory_stale = task_source_inventory_is_stale(session, task_source)
    return ProjectTaskSource(
        project=task_source.project,
        source_type=task_source.source_type,
        display_name=task_source.display_name,
        repository_url=task_source.repository_url,
        git_ref=task_source.git_ref,
        subpath=task_source.subpath,
        filesystem_path=task_source.filesystem_path,
        demo_seed_id=task_source.demo_seed_id,
        status=task_source.status,
        last_synced_at=task_source.last_synced_at,
        last_resolved_commit_sha=task_source.last_resolved_commit_sha,
        last_error=task_source.last_error,
        inventory_stale=inventory_stale,
    )


def mark_syncing(session: Session, row: ProjectTaskSourceDB) -> None:
    """Mark a task source as mid-sync. Used by the sync endpoint."""
    if row.status not in VALID_STATUSES:
        return
    row.status = "syncing"
    row.updated_at = datetime.now(timezone.utc)
    session.add(row)
    session.commit()
    session.refresh(row)


def mark_ready(
    session: Session,
    row: ProjectTaskSourceDB,
    *,
    resolved_commit_sha: str | None = None,
) -> None:
    """Mark a task source as ready after a successful sync."""
    row.status = "ready"
    row.last_synced_at = datetime.now(timezone.utc)
    row.last_error = None
    if resolved_commit_sha is not None:
        row.last_resolved_commit_sha = resolved_commit_sha
    row.updated_at = datetime.now(timezone.utc)
    session.add(row)
    session.commit()
    session.refresh(row)


def mark_error(session: Session, row: ProjectTaskSourceDB, message: str) -> None:
    """Mark a task source as failing with a human-readable error message."""
    row.status = "error"
    row.last_error = message
    row.updated_at = datetime.now(timezone.utc)
    session.add(row)
    session.commit()
    session.refresh(row)
