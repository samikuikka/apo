"""Source-Owned Connected Executor services.

Owns: canonical source-owned Pool creation, member-authorized bootstrap,
catalog eligibility checks, and source-owned claim filtering.

Reuses the existing executor identity, enrollment, and lease services.
Does not duplicate credential hashing, JWT issuance, or finalization.
"""

# pyright: reportUnusedImport=false, reportUnusedParameter=false

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlmodel import Session, select

from ..models.db import ExecutorPoolDB, ProjectTaskSourceDB
from .executor_auth import generate_enrollment_token


@dataclass(frozen=True)
class BootstrapResult:
    """Result of a member-authorized executor bootstrap."""

    enrollment_token: str
    protocol_version: int
    expires_at: datetime


def ensure_source_owned_pool(session: Session, project_id: str) -> ExecutorPoolDB:
    """Ensure the canonical system-managed source-owned Pool exists for a Project.

    Creates it if absent, returns the existing one if present. Idempotent.
    The Pool has:
    - slug: "source-owned"
    - kind: "connected"
    - system_managed: True
    - required_driver_kind: "source-owned-ts"
    """
    existing = session.exec(
        select(ExecutorPoolDB).where(
            ExecutorPoolDB.project == project_id,
            ExecutorPoolDB.slug == "source-owned",
        )
    ).first()

    if existing is not None:
        return existing

    pool = ExecutorPoolDB(
        project=project_id,
        name="Source-Owned Tasks",
        slug="source-owned",
        kind="connected",
        system_managed=True,
        required_driver_kind="source-owned-ts",
        enabled=True,
    )
    session.add(pool)
    session.commit()
    session.refresh(pool)
    return pool


def bootstrap_connected_executor(
    session: Session,
    *,
    project_id: str,
    user_id: str,
    name: str,
) -> BootstrapResult:
    """Member-authorized bootstrap for a source-owned Connected Executor.

    1. Ensures the canonical source-owned Pool exists.
    2. Issues a one-time enrollment token bound to the Pool and User.
    3. Returns the raw token (returned once, never persisted in plaintext).
    """
    pool = ensure_source_owned_pool(session, project_id)

    raw_token, row = generate_enrollment_token(
        session,
        scope_kind="pool",
        project_id=project_id,
        pool_id=pool.id,
        created_by_user_id=user_id,
    )

    return BootstrapResult(
        enrollment_token=raw_token,
        protocol_version=2,
        expires_at=row.expires_at,
    )


def check_catalog_eligibility(
    session: Session,
    project_id: str,
    local_catalog_digest: str,
) -> dict[str, object]:
    """Check whether the executor's local catalog matches the Project's published one.

    Returns one of:
    - {"status": "ready", "project_catalog_digest": "<digest>"}
    - {"status": "catalog_mismatch", "project_catalog_digest": "<digest>"}
    - {"status": "catalog_missing", "project_catalog_digest": None}
    """
    source = session.exec(
        select(ProjectTaskSourceDB).where(ProjectTaskSourceDB.project == project_id)
    ).first()

    if source is None or source.source_type != "published" or not source.catalog_digest:
        return {"status": "catalog_missing", "project_catalog_digest": None}

    if source.catalog_digest == local_catalog_digest:
        return {"status": "ready", "project_catalog_digest": source.catalog_digest}

    return {"status": "catalog_mismatch", "project_catalog_digest": source.catalog_digest}
