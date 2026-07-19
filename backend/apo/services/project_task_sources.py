"""Project task source service (SPEC-118).

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

from fastapi import HTTPException
from sqlmodel import Session, select

from ..models.db import ProjectDB, ProjectTaskSourceDB
from ..models.schemas import ProjectTaskSource, UpdateProjectTaskSourceRequest

DEMO_PROJECT_ID: Final[str] = "demo"

VALID_SOURCE_TYPES: Final[frozenset[str]] = frozenset({"git", "filesystem", "demo"})

# Status values used across the task source lifecycle. ``syncing`` is
# included so SPEC-119 (and the temporary sync stub) can mark a source
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


def upsert_task_source(
    session: Session,
    project_id: str,
    request: UpdateProjectTaskSourceRequest,
) -> ProjectTaskSourceDB:
    """Validate the request and create or replace the project's task source.

    Transition rules:

    - Source type must be one of ``git``, ``filesystem``, ``demo``.
    - Git sources require ``repository_url``; ``git_ref`` defaults to
      ``main`` if omitted, ``subpath`` is optional.
    - Filesystem sources require ``filesystem_path``.
    - Demo sources only require a ``display_name`` (default applied).
    - Switching source type wipes fields that do not apply to the new
      mode so stale data is not retained.
    - On create, status becomes ``pending_sync``.
    - On update, only runtime-affecting source changes reset the source
      to ``pending_sync`` and clear stale sync state. Display-name-only
      edits do not invalidate inventory.
    """
    source_type = request.source_type.strip()
    if source_type not in VALID_SOURCE_TYPES:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Invalid source_type '{source_type}'. "
                "Expected one of: git, filesystem, demo."
            ),
        )

    display_name = (request.display_name or "").strip() or _default_display_name(source_type)

    repository_url: str | None = None
    git_ref: str | None = None
    subpath: str | None = None
    filesystem_path: str | None = None
    demo_seed_id: str | None = None

    if source_type == "git":
        repository_url = (request.repository_url or "").strip() or None
        if not repository_url:
            raise HTTPException(
                status_code=422,
                detail="repository_url is required for git task sources.",
            )
        git_ref = (request.git_ref or "").strip() or "main"
        subpath_raw = (request.subpath or "").strip()
        subpath = subpath_raw or None
    elif source_type == "filesystem":
        filesystem_path = (request.filesystem_path or "").strip() or None
        if not filesystem_path:
            raise HTTPException(
                status_code=422,
                detail="filesystem_path is required for filesystem task sources.",
            )
    elif source_type == "demo":
        demo_seed_id = (request.demo_seed_id or "").strip() or None

    existing = get_task_source_db(session, project_id)
    now = datetime.now(timezone.utc)

    if existing is None:
        row = ProjectTaskSourceDB(
            project=project_id,
            source_type=source_type,
            display_name=display_name,
            repository_url=repository_url,
            git_ref=git_ref,
            subpath=subpath,
            filesystem_path=filesystem_path,
            demo_seed_id=demo_seed_id,
            status="pending_sync",
            last_error=None,
            created_at=now,
            updated_at=now,
        )
        session.add(row)
    else:
        source_changed = any(
            (
                existing.source_type != source_type,
                existing.repository_url != repository_url,
                existing.git_ref != git_ref,
                existing.subpath != subpath,
                existing.filesystem_path != filesystem_path,
                existing.demo_seed_id != demo_seed_id,
            )
        )
        existing.source_type = source_type
        existing.display_name = display_name
        existing.repository_url = repository_url
        existing.git_ref = git_ref
        existing.subpath = subpath
        existing.filesystem_path = filesystem_path
        existing.demo_seed_id = demo_seed_id
        # Only runtime-affecting source changes invalidate inventory.
        if source_changed:
            existing.status = "pending_sync"
            existing.last_error = None
            existing.last_resolved_commit_sha = None
        existing.updated_at = now
        row = existing

    session.commit()
    session.refresh(row)
    return row


def mark_syncing(session: Session, row: ProjectTaskSourceDB) -> None:
    """Mark a task source as mid-sync. Used by the sync endpoint (SPEC-119)."""
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
    """Mark a task source as ready after a successful sync (SPEC-119)."""
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


def ensure_demo_task_source(session: Session) -> None:
    """Ensure the demo project has an explicit ``demo`` task source row.

    Called during demo workspace seeding so the demo project advertises
    its source explicitly instead of relying on the legacy
    ``DEFAULT_TASK_ROOT`` fallback. Idempotent: if a demo source already
    exists it is left untouched.

    On first creation, also seeds the demo task inventory from the
    bundled example-service workspace so the project-scoped
    ``/v1/projects/demo/agent-tasks`` endpoint returns real tasks.
    """
    demo_project = session.get(ProjectDB, DEMO_PROJECT_ID)
    if demo_project is None:
        return

    existing = get_task_source_db(session, DEMO_PROJECT_ID)
    if existing is not None:
        return

    now = datetime.now(timezone.utc)
    row = ProjectTaskSourceDB(
        project=DEMO_PROJECT_ID,
        source_type="demo",
        display_name="Demo workspace",
        demo_seed_id="example-service",
        status="ready",
        last_synced_at=now,
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    session.commit()
    session.refresh(row)

    # Populate inventory on first creation so the demo project's
    # project-scoped task routes return real tasks immediately. Re-syncs
    # happen explicitly via ``POST .../task-source/sync`` (but demo is
    # read-only in normal use, so this branch only runs once).
    from .project_task_inventory import seed_demo_inventory

    _ = seed_demo_inventory(session, row)


def _default_display_name(source_type: str) -> str:
    if source_type == "git":
        return "Git repository"
    if source_type == "filesystem":
        return "Local filesystem"
    if source_type == "demo":
        return "Demo workspace"
    return "Task source"
