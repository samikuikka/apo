"""Aggregate Connected Executor status for one Project member.

Computes one ``ConnectedEnvironmentState`` from the authoritative database
state of the non-revoked source-owned Executors whose ``enrolled_by_user_id``
equals the acting User. Used by both the dashboard status route and the
queued source-owned Attempt projection (``waiting_reason``).

The database's active ``leased`` plus ``running`` Attempts and persisted
``max_concurrency`` remain the capacity authority. Client-reported
``reported_available_slots`` improves freshness but never grants capacity.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from typing import cast

from sqlmodel import Session, func, select

from apo.db_helpers import as_column
from apo.models.execution import SUPPORTED_EXECUTOR_PROTOCOL_VERSIONS
from ..models.db import ExecutorDB, ProjectTaskSourceDB, TaskExecutionAttemptDB
from ..models.execution import (
    ConnectedEnvironmentState,
    ConnectedEnvironmentStatus,
)

#: Mirror of the executor-management offline threshold.
_EXECUTOR_OFFLINE_THRESHOLD_SECONDS = 60

#: Source-owned driver requirement.
_SOURCE_OWNED_DRIVER_KIND = "source-owned-ts"

# Aggregate precedence rank (lower wins). ``not_connected`` is the fallback
# when the User owns no eligible Executors.
_PRECEDENCE: dict[str, int] = {
    "ready": 0,
    "busy": 1,
    "catalog_mismatch": 2,
    "incompatible": 3,
    "offline": 4,
    "not_connected": 5,
}


def compute_connected_environment_state(
    session: Session,
    *,
    project_id: str,
    user_id: str,
    now: datetime | None = None,
) -> ConnectedEnvironmentState:
    """Return the aggregate connected-environment state for one User.

    Considers only non-revoked, enabled Executors whose
    ``enrolled_by_user_id`` equals ``user_id``. Applies the documented
    precedence: ready > busy > catalog_mismatch > incompatible >
    offline > not_connected.
    """
    executors = _user_source_owned_executors(session, project_id=project_id, user_id=user_id)
    if not executors:
        return "not_connected"

    project_digest = _project_catalog_digest(session, project_id)
    current = now or datetime.now(timezone.utc)
    active_counts = _active_attempt_counts(session, [ex.id for ex in executors])

    best = _PRECEDENCE["not_connected"]
    for executor in executors:
        bucket = _classify_executor(
            executor,
            project_digest=project_digest,
            active_count=active_counts.get(executor.id, 0),
            now=current,
        )
        rank = _PRECEDENCE[bucket]
        if rank < best:
            best = rank
    return _state_for_rank(best)


def compute_connected_environment_status(
    session: Session,
    *,
    project_id: str,
    user_id: str,
    now: datetime | None = None,
) -> ConnectedEnvironmentStatus:
    """Return the public aggregate status view model (``{ "state": ... }``)."""
    return ConnectedEnvironmentStatus(
        state=compute_connected_environment_state(
            session, project_id=project_id, user_id=user_id, now=now
        )
    )


# ---------------------------------------------------------------------------
# Implementation helpers (below public logic)
# ---------------------------------------------------------------------------


def _user_source_owned_executors(
    session: Session,
    *,
    project_id: str,
    user_id: str,
) -> list[ExecutorDB]:
    """Non-revoked, enabled source-owned Executors owned by ``user_id``."""
    return list(
        session.exec(
            select(ExecutorDB).where(
                ExecutorDB.project == project_id,
                ExecutorDB.enrolled_by_user_id == user_id,
                as_column(ExecutorDB.revoked_at).is_(None),
                as_column(ExecutorDB.enabled).is_(True),
            )
        ).all()
    )


def _project_catalog_digest(session: Session, project_id: str) -> str | None:
    source = session.exec(
        select(ProjectTaskSourceDB).where(ProjectTaskSourceDB.project == project_id)
    ).first()
    if source is None or source.source_type != "published":
        return None
    return source.catalog_digest or None


def _active_attempt_counts(
    session: Session, executor_ids: Sequence[str]
) -> dict[str, int]:
    """Authoritative leased+running Attempt counts keyed by executor id."""
    if not executor_ids:
        return {}
    rows = session.exec(
        select(
            TaskExecutionAttemptDB.executor_id,
            func.count(),
        ).where(
            as_column(TaskExecutionAttemptDB.executor_id).in_(executor_ids),
            as_column(TaskExecutionAttemptDB.status).in_(["leased", "running"]),
        ).group_by(TaskExecutionAttemptDB.executor_id)
    ).all()
    return {str(executor_id): int(count) for executor_id, count in rows}


def _classify_executor(
    executor: ExecutorDB,
    *,
    project_digest: str | None,
    active_count: int,
    now: datetime,
) -> ConnectedEnvironmentState:
    """Classify a single executor into one aggregate bucket."""
    if _is_offline(executor, now=now):
        return "offline"
    if not _is_protocol_driver_compatible(executor):
        return "incompatible"
    if not _catalog_matches(executor, project_digest=project_digest):
        return "catalog_mismatch"
    if active_count >= max(executor.max_concurrency, 1):
        return "busy"
    return "ready"


def _is_offline(executor: ExecutorDB, *, now: datetime) -> bool:
    if executor.last_seen_at is None:
        return True
    return now - executor.last_seen_at > timedelta(seconds=_EXECUTOR_OFFLINE_THRESHOLD_SECONDS)


def _is_protocol_driver_compatible(executor: ExecutorDB) -> bool:
    # The same set the claim path gates on, so "incompatible" never names an
    # executor that would still claim attempts.
    if executor.protocol_version not in SUPPORTED_EXECUTOR_PROTOCOL_VERSIONS:
        return False
    return _SOURCE_OWNED_DRIVER_KIND in (executor.driver_kinds_json or [])


def _catalog_matches(executor: ExecutorDB, *, project_digest: str | None) -> bool:
    if project_digest is None:
        return False
    return executor.reported_catalog_digest == project_digest


def _state_for_rank(rank: int) -> ConnectedEnvironmentState:
    for state, state_rank in _PRECEDENCE.items():
        if state_rank == rank:
            return cast(ConnectedEnvironmentState, state)
    return "not_connected"


__all__ = [
    "compute_connected_environment_state",
    "compute_connected_environment_status",
]
