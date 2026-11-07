"""Retire bundled execution and purge Control Plane Bundle objects.

Two idempotent startup operations called in ``api.py::lifespan`` after
``init_db()`` and before scheduler/reaper/demo startup:

1. ``retire_legacy_execution_rows`` — fence all legacy bundled execution state
   so no scheduler/reaper treats it as active, while preserving the installation
   identity, catalogs, results, traces, and deliverables.

2. ``purge_legacy_bundle_objects`` — narrowly delete every Bundle object from
   the shared ArtifactStore and clear its storage reference, without touching
   Deliverable objects or store siblings.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import cast

from sqlmodel import Session, func, select

from apo.db_helpers import as_column
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    AgentTaskScheduleOccurrenceDB,
    ExecutorDB,
    ExecutorEnrollmentTokenDB,
    ExecutorPoolDB,
    ProjectDB,
    TaskExecutionAttemptDB,
    TaskRevisionDB,
)
from apo.services.execution_leases import transition_attempt
from apo.services.lifecycle import TASK_RUN_TERMINAL, BATCH_RUN_TERMINAL

logger = logging.getLogger(__name__)

#: Stable reasons recorded on retired rows.
BUNDLED_SCHEDULE_RETIRED_REASON = "bundled_execution_retired"
EXECUTION_RETIRED_FAILURE_KIND = "execution_retired"

#: Bounded batch size for Bundle object purging (crash-safe progress).
_PURGE_BATCH_SIZE = 50


def retire_legacy_execution_rows(session: Session, *, now: datetime | None = None) -> int:
    """Fence all legacy bundled execution state. Idempotent. Returns rows changed.

    - Disables ``execution_kind="bundled"`` Schedules with a stable reason.
    - Terminalizes queued/leased/running ``assignment_kind="bundled"`` Attempts
      as cancelled with ``failure_kind="execution_retired"``.
    - Rolls their linked Task Runs / Batches into terminal state.
    - Stamps ``completed_at`` on terminal Batches that lack one.
    - Revokes non-source-owned persistent Executors + legacy enrollment tokens.
    - Disables/archives non-system legacy Pools; clears stale Project defaults.
    - Preserves caller/source-owned work, the canonical source-owned Pool, and
      all identity/catalog/result data.
    """
    ts = now or datetime.now(timezone.utc)
    changed = 0

    changed += _retire_bundled_schedules(session, ts)
    changed += _retire_bundled_attempts(session, ts)
    changed += _stamp_terminal_batches_without_end(session)
    changed += _retire_legacy_executors(session, ts)
    changed += _retire_legacy_pools(session, ts)

    if changed:
        session.commit()
    return changed


async def purge_legacy_bundle_objects(session: Session) -> int:
    """Narrowly delete every Bundle object from the shared ArtifactStore.

    Selects only ``TaskRevisionDB`` rows with a non-null ``bundle_storage_key``,
    resolves the exact recorded store for each, idempotently deletes that one
    key, then clears the four ``bundle_*`` fields. Commits in bounded batches
    so a restart resumes safely. An already-missing object is success.
    """
    from apo.services.task_revisions import delete_task_revision_bundle

    total = 0
    while True:
        rows = session.exec(
            select(TaskRevisionDB).where(
                as_column(TaskRevisionDB.bundle_storage_key).is_not(None)
            ).limit(_PURGE_BATCH_SIZE)
        ).all()
        if not rows:
            break
        for revision in rows:
            try:
                await delete_task_revision_bundle(revision)
            except Exception as exc:  # noqa: BLE001 — fail closed with context
                raise RuntimeError(
                    f"Failed to purge bundle object for revision {revision.id}: {exc}"
                ) from exc
            revision.bundle_storage_backend = None
            revision.bundle_storage_key = None
            revision.bundle_sha256 = None
            revision.bundle_size_bytes = None
            session.add(revision)
            total += 1
        session.commit()
    return total


# ---------------------------------------------------------------------------
# Implementation helpers
# ---------------------------------------------------------------------------


def _retire_bundled_schedules(session: Session, ts: datetime) -> int:
    schedules = session.exec(
        select(AgentTaskScheduleDB).where(
            AgentTaskScheduleDB.execution_kind == "bundled",
        )
    ).all()
    changed = 0
    for schedule in schedules:
        if schedule.enabled or schedule.disabled_reason != BUNDLED_SCHEDULE_RETIRED_REASON:
            schedule.enabled = False
            schedule.disabled_reason = BUNDLED_SCHEDULE_RETIRED_REASON
            schedule.next_run_at = None
            schedule.active_batch_run_id = None
            session.add(schedule)
            changed += 1
        # Cancel any pending occurrences owned by this schedule.
        occs = session.exec(
            select(AgentTaskScheduleOccurrenceDB).where(
                AgentTaskScheduleOccurrenceDB.schedule_id == schedule.id,
                AgentTaskScheduleOccurrenceDB.status == "pending",
            )
        ).all()
        for occ in occs:
            occ.status = "cancelled"
            occ.resolved_at = ts
            session.add(occ)
    return changed


def _retire_bundled_attempts(session: Session, ts: datetime) -> int:
    """Terminalize active bundled Attempts and roll up their Runs/Batches."""
    active = session.exec(
        select(TaskExecutionAttemptDB).where(
            TaskExecutionAttemptDB.assignment_kind == "bundled",
            as_column(TaskExecutionAttemptDB.status).in_(["queued", "leased", "running"]),
        )
    ).all()
    changed = 0
    for attempt in active:
        transition_attempt(attempt, "cancelled")
        attempt.failure_kind = EXECUTION_RETIRED_FAILURE_KIND
        attempt.error_message = "bundled execution retired"
        attempt.completed_at = ts
        attempt.lease_expires_at = None
        attempt.executor_id = None
        session.add(attempt)
        changed += 1
        _roll_up_logical_run(session, attempt, ts)
    return changed


def _roll_up_logical_run(session: Session, attempt: TaskExecutionAttemptDB, ts: datetime) -> None:
    task_run = session.get(AgentTaskRunDB, attempt.task_run_id)
    if task_run is not None and task_run.status not in (*TASK_RUN_TERMINAL, "cancelled"):
        task_run.status = "error"
        task_run.no_verdict_reason = "executor"
        task_run.error_message = "bundled execution retired"
        task_run.completed_at = ts
        session.add(task_run)
    batch = session.get(AgentTaskBatchRunDB, attempt.batch_run_id)
    if batch is not None and batch.status not in BATCH_RUN_TERMINAL:
        batch.status = "error"
        batch.completed_at = batch.completed_at or ts
        batch.cancelled_tasks = (batch.cancelled_tasks or 0) + 1
        session.add(batch)


def _stamp_terminal_batches_without_end(session: Session) -> int:
    """Give terminal Batches without ``completed_at`` their last Task Run's end.

    Repairs Batches retired before the roll-up stamped an end. A Batch with no
    finished Task Run stays unstamped: inventing an end would invent a duration.
    """
    batches = session.exec(
        select(AgentTaskBatchRunDB).where(
            as_column(AgentTaskBatchRunDB.status).in_(list(BATCH_RUN_TERMINAL)),
            as_column(AgentTaskBatchRunDB.completed_at).is_(None),
        )
    ).all()
    if not batches:
        return 0
    last_ends: dict[str, datetime | None] = dict(
        session.exec(
            select(AgentTaskRunDB.batch_run_id, func.max(AgentTaskRunDB.completed_at))
            .where(as_column(AgentTaskRunDB.batch_run_id).in_([b.id for b in batches]))
            .group_by(AgentTaskRunDB.batch_run_id)
        ).all()
    )
    stamped = 0
    for batch in batches:
        last_end = last_ends.get(batch.id)
        if last_end is None:
            continue
        batch.completed_at = last_end
        session.add(batch)
        stamped += 1
    return stamped


def _retire_legacy_executors(session: Session, ts: datetime) -> int:
    """Revoke non-source-owned persistent Executors + legacy enrollment tokens."""
    changed = 0
    executors = session.exec(
        select(ExecutorDB).where(
            as_column(ExecutorDB.revoked_at).is_(None),
            as_column(ExecutorDB.enrolled_by_user_id).is_(None),
        )
    ).all()
    for ex in executors:
        ex.revoked_at = ts
        ex.enabled = False
        session.add(ex)
        changed += 1
    tokens = session.exec(
        select(ExecutorEnrollmentTokenDB).where(
            as_column(ExecutorEnrollmentTokenDB.used_at).is_(None),
            as_column(ExecutorEnrollmentTokenDB.revoked_at).is_(None),
        )
    ).all()
    for token in tokens:
        token.revoked_at = ts
        session.add(token)
        changed += 1
    return changed


def _retire_legacy_pools(session: Session, ts: datetime) -> int:
    """Disable/archive non-system legacy Pools and clear stale Project defaults."""
    changed = 0
    pools = session.exec(
        select(ExecutorPoolDB).where(
            cast(object, ExecutorPoolDB.system_managed) == False,  # noqa: E712
        )
    ).all()
    legacy_pool_ids: list[str] = []
    for pool in pools:
        if pool.enabled or pool.archived_at is None:
            pool.enabled = False
            pool.archived_at = ts
            session.add(pool)
            changed += 1
        legacy_pool_ids.append(pool.id)
    if legacy_pool_ids:
        projects = session.exec(
            select(ProjectDB).where(
                as_column(ProjectDB.default_executor_pool_id).in_(legacy_pool_ids)
            )
        ).all()
        for project in projects:
            project.default_executor_pool_id = None
            session.add(project)
            changed += 1
    return changed


__all__ = [
    "BUNDLED_SCHEDULE_RETIRED_REASON",
    "EXECUTION_RETIRED_FAILURE_KIND",
    "purge_legacy_bundle_objects",
    "retire_legacy_execution_rows",
]
