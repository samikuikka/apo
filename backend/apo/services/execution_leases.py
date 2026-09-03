# pyright: reportPrivateUsage=false, reportUnusedImport=false

"""Lease state machine — atomic claim, start/heartbeat fencing, reaper.

The database is authoritative for ownership; an Executor's heartbeat or request
body is never trusted as status. The state machine:

    queued -> leased -> cancelled -> failed(executor_unavailable)
    leased -> running -> queued (pre-start expiry) -> cancelled
    running -> succeeded -> failed -> cancelled -> lost (post-start expiry)

No automatic retry after ``/start``: Tasks may spend money or cause external
side effects and may still run during a network partition.

Atomic claim (§Atomic claim): SELECT oldest eligible queued attempt in scope,
conditional UPDATE only when status remains queued, confirm one affected row.
SQLite uses conditional UPDATE + WAL/busy_timeout (no Redis, no SKIP LOCKED);
PostgreSQL may additionally use ``SKIP LOCKED``.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import func, update
from sqlalchemy.orm import aliased
from sqlmodel import Session, select

from apo.db_helpers import as_column
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    ExecutorDB,
    TaskExecutionAttemptDB,
)
from apo.models.execution import EXECUTOR_PROTOCOL_VERSION
from apo.services.executor_auth import ATTEMPT_LEASE_SECONDS
from apo.services.lifecycle import TASK_RUN_TERMINAL

# Attempt statuses.
QUEUED = "queued"
LEASED = "leased"
RUNNING = "running"
SUCCEEDED = "succeeded"
FAILED = "failed"
CANCELLED = "cancelled"
LOST = "lost"

TERMINAL_STATUSES = frozenset({SUCCEEDED, FAILED, CANCELLED, LOST})
NONTERMINAL_STATUSES = frozenset({QUEUED, LEASED, RUNNING})


class LeaseError(Exception):
    """Typed lease failure (stale_generation / state_mismatch / not_found)."""

    kind: str

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(f"[{kind}] {message}")
        self.kind = kind


def lease_error_to_http(exc: LeaseError) -> HTTPException:
    """Map a lease failure onto the executor-protocol HTTP contract.

    Both protocol versions (v1 and v2 routes) raise this mapping so error
    semantics cannot drift between them.
    """
    if exc.kind in ("stale_generation", "state_mismatch"):
        return HTTPException(status.HTTP_409_CONFLICT, detail={"kind": "lease_stale", "msg": str(exc)})
    if exc.kind == "not_found":
        return HTTPException(status.HTTP_404_NOT_FOUND, str(exc))
    return HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


@dataclass(frozen=True)
class CurrentAttemptLease:
    """The current generation-fenced capability an Executor holds for an Attempt."""

    attempt_id: str
    lease_generation: int
    executor_id: str


@dataclass(frozen=True)
class ClaimedAttempt:
    """Result of a successful claim: the leased row + the fenced lease."""

    attempt: TaskExecutionAttemptDB
    lease: CurrentAttemptLease


@dataclass(frozen=True)
class HeartbeatResponse:
    """Heartbeat renewal result: whether the Executor should stop."""

    cancel_requested: bool


@dataclass(frozen=True)
class RecoveryCounts:
    """Reaper outcome counts by recovery action."""

    requeued: int
    lost: int
    failed_unavailable: int


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _active_count(session: Session, executor: ExecutorDB) -> int:
    """Leased+running attempts held by this executor (drives capacity)."""
    rows = session.exec(
        select(TaskExecutionAttemptDB).where(
            as_column(TaskExecutionAttemptDB.executor_id) == executor.id,
            as_column(TaskExecutionAttemptDB.status).in_([LEASED, RUNNING]),
        )
    ).all()
    return len(rows)


def _lock_executor_for_claim(
    session: Session,
    executor_id: str,
) -> ExecutorDB | None:
    """Serialize capacity decisions for one Executor.

    PostgreSQL's row lock prevents two claims for different Attempt rows from
    both observing the same free slot. SQLite serializes writes at the database
    level and safely ignores ``FOR UPDATE``.
    """
    return session.exec(
        select(ExecutorDB)
        .where(as_column(ExecutorDB.id) == executor_id)
        .with_for_update()
    ).one_or_none()


def _sequential_blocker(session: Session, attempt: TaskExecutionAttemptDB) -> bool:
    """True if a lower sequence_index attempt in the same Batch is non-terminal."""
    blockers = session.exec(
        select(TaskExecutionAttemptDB).where(
            as_column(TaskExecutionAttemptDB.batch_run_id) == attempt.batch_run_id,
            as_column(TaskExecutionAttemptDB.sequence_index) < attempt.sequence_index,
        )
    ).all()
    return any(b.status in NONTERMINAL_STATUSES for b in blockers)


def claim_next_attempt(
    session: Session,
    *,
    executor: ExecutorDB,
    accepted_driver_kinds: frozenset[str],
) -> ClaimedAttempt | None:
    """Atomically lease the oldest eligible queued Attempt in Executor scope.

    Eligibility: Pool enabled + not archived, queue TTL live, compatible driver
    kind, executor capacity (from the DB, not the request hint), and — preserving
    sequential Batch behavior — all lower ``sequence_index`` Attempts terminal.
    Returns None when no work is available.
    """
    now = _now()
    locked_executor = _lock_executor_for_claim(session, executor.id)
    if (
        locked_executor is None
        or locked_executor.revoked_at is not None
        or not locked_executor.enabled
        or locked_executor.protocol_version != EXECUTOR_PROTOCOL_VERSION
    ):
        return None
    executor = locked_executor

    # Pool scope: a pool-scoped executor claims only its own pool's attempts.
    scope_filter = (
        as_column(TaskExecutionAttemptDB.target_kind) == "pool",
        as_column(TaskExecutionAttemptDB.status) == QUEUED,
    )
    if executor.scope_kind == "pool":
        if executor.executor_pool_id is None:
            return None
        scope_filter = (*scope_filter, as_column(TaskExecutionAttemptDB.executor_pool_id) == executor.executor_pool_id)
    elif executor.scope_kind != "installation":
        return None

    candidates = session.exec(
        select(TaskExecutionAttemptDB).where(*scope_filter).order_by(as_column(TaskExecutionAttemptDB.queued_at))
    ).all()

    if _active_count(session, executor) >= executor.max_concurrency:
        return None

    driver_kinds = set(executor.driver_kinds_json or [])
    if not (driver_kinds & accepted_driver_kinds):
        return None

    for attempt in candidates:
        if attempt.queue_expires_at <= now:
            continue  # TTL expired; the reaper will fail it
        pool = _pool_for(session, attempt)
        if pool is None or not pool.enabled or pool.archived_at is not None:
            continue
        if executor.scope_kind == "installation" and pool.kind != "bundled":
            continue
        if (
            pool.required_driver_kind not in accepted_driver_kinds
            or pool.required_driver_kind not in driver_kinds
        ):
            continue
        if _sequential_blocker(session, attempt):
            continue

        new_generation = attempt.lease_generation + 1
        active_attempt = aliased(TaskExecutionAttemptDB)
        active_count = (
            select(func.count())
            .select_from(active_attempt)
            .where(
                active_attempt.executor_id == executor.id,
                as_column(active_attempt.status).in_([LEASED, RUNNING]),
            )
            .scalar_subquery()
        )
        result = session.exec(
            update(TaskExecutionAttemptDB)
            .where(
                as_column(TaskExecutionAttemptDB.id) == attempt.id,
                as_column(TaskExecutionAttemptDB.status) == QUEUED,
                active_count < executor.max_concurrency,
            )
            .values(
                status=LEASED,
                executor_id=executor.id,
                claimed_at=now,
                heartbeat_at=now,
                lease_expires_at=now + timedelta(seconds=ATTEMPT_LEASE_SECONDS),
                lease_generation=new_generation,
            )
        )
        session.commit()
        if result.rowcount == 1:
            session.refresh(attempt)
            return ClaimedAttempt(
                attempt=attempt,
                lease=CurrentAttemptLease(
                    attempt_id=attempt.id,
                    lease_generation=new_generation,
                    executor_id=executor.id,
                ),
            )
        # lost the race to a concurrent executor; continue to next candidate
    return None


def claim_next_source_owned_attempt(
    session: Session,
    *,
    executor: ExecutorDB,
) -> ClaimedAttempt | None:
    """Atomically lease the oldest eligible source-owned Attempt.

    Reuses the same database-backed capacity/sequential/TTL/atomic-race
    authority as ``claim_next_attempt`` but targets source-owned work:
    queued ``assignment_kind="source_owned"`` Attempts in this Executor's
    canonical source-owned Pool whose ``target_user_id`` equals the
    Executor's ``enrolled_by_user_id``. Requires protocol v2 and the
    ``source-owned-ts`` driver. Client-reported ``available_slots`` may
    suppress a claim but never grants capacity.
    """
    from apo.models.execution import SUPPORTED_EXECUTOR_PROTOCOL_VERSIONS

    now = _now()
    locked_executor = _lock_executor_for_claim(session, executor.id)
    if (
        locked_executor is None
        or locked_executor.revoked_at is not None
        or not locked_executor.enabled
        or locked_executor.enrolled_by_user_id is None
        or locked_executor.protocol_version not in SUPPORTED_EXECUTOR_PROTOCOL_VERSIONS
        or locked_executor.protocol_version < 2
        or locked_executor.executor_pool_id is None
    ):
        return None
    executor = locked_executor

    driver_kinds = set(executor.driver_kinds_json or [])
    if "source-owned-ts" not in driver_kinds:
        return None
    if _active_count(session, executor) >= executor.max_concurrency:
        return None

    candidates = session.exec(
        select(TaskExecutionAttemptDB)
        .where(
            TaskExecutionAttemptDB.status == QUEUED,
            TaskExecutionAttemptDB.assignment_kind == "source_owned",
            TaskExecutionAttemptDB.executor_pool_id == executor.executor_pool_id,
            TaskExecutionAttemptDB.target_user_id == executor.enrolled_by_user_id,
        )
        .order_by(as_column(TaskExecutionAttemptDB.queued_at))
    ).all()

    for attempt in candidates:
        if attempt.queue_expires_at <= now:
            continue  # TTL expired; the reaper will fail it
        pool = _pool_for(session, attempt)
        if pool is None or not pool.enabled or pool.archived_at is not None:
            continue
        if pool.required_driver_kind != "source-owned-ts":
            continue
        if _sequential_blocker(session, attempt):
            continue

        new_generation = attempt.lease_generation + 1
        active_attempt = aliased(TaskExecutionAttemptDB)
        active_count = (
            select(func.count())
            .select_from(active_attempt)
            .where(
                active_attempt.executor_id == executor.id,
                as_column(active_attempt.status).in_([LEASED, RUNNING]),
            )
            .scalar_subquery()
        )
        result = session.exec(
            update(TaskExecutionAttemptDB)
            .where(
                as_column(TaskExecutionAttemptDB.id) == attempt.id,
                as_column(TaskExecutionAttemptDB.status) == QUEUED,
                active_count < executor.max_concurrency,
            )
            .values(
                status=LEASED,
                executor_id=executor.id,
                claimed_at=now,
                heartbeat_at=now,
                lease_expires_at=now + timedelta(seconds=ATTEMPT_LEASE_SECONDS),
                lease_generation=new_generation,
            )
        )
        session.commit()
        if result.rowcount == 1:
            session.refresh(attempt)
            return ClaimedAttempt(
                attempt=attempt,
                lease=CurrentAttemptLease(
                    attempt_id=attempt.id,
                    lease_generation=new_generation,
                    executor_id=executor.id,
                ),
            )
    return None


def _pool_for(session: Session, attempt: TaskExecutionAttemptDB):
    from apo.models.db import ExecutorPoolDB

    if attempt.executor_pool_id is None:
        return None
    return session.get(ExecutorPoolDB, attempt.executor_pool_id)


def _require_current(session: Session, lease: CurrentAttemptLease) -> TaskExecutionAttemptDB:
    """Load the attempt and verify the lease matches its current generation."""
    attempt = session.get(TaskExecutionAttemptDB, lease.attempt_id)
    if attempt is None:
        raise LeaseError("not_found", "attempt not found")
    if attempt.lease_generation != lease.lease_generation:
        raise LeaseError("stale_generation", "lease generation does not match current")
    # Caller Attempts carry no persistent Executor (executor_id is None); treat
    # None and "" as equivalent so the own-only check passes for caller leases.
    if (attempt.executor_id or "") != (lease.executor_id or ""):
        raise LeaseError("stale_generation", "lease executor does not own this attempt")
    if (
        attempt.status in NONTERMINAL_STATUSES
        and (
            attempt.lease_expires_at is None
            or attempt.lease_expires_at <= _now()
        )
    ):
        raise LeaseError("stale_generation", "attempt lease has expired")
    return attempt


def start_attempt(
    session: Session,
    *,
    lease: CurrentAttemptLease,
    driver_kind: str,
    runtime: dict[str, str],
) -> TaskExecutionAttemptDB:
    """Fence the point before any customer-controlled code executes.

    Idempotent for the same current generation (a repeat ``/start`` with the
    same generation is a no-op once running). Raises ``LeaseError`` on a stale
    generation or wrong executor.
    """
    attempt = _require_current(session, lease)
    if attempt.status == RUNNING:
        return attempt  # idempotent re-start at the same generation
    if attempt.status != LEASED:
        raise LeaseError("state_mismatch", f"cannot start from status {attempt.status!r}")
    attempt.status = RUNNING
    attempt.phase = "preparing"
    attempt.started_at = _now()
    attempt.heartbeat_at = _now()
    attempt.lease_expires_at = _now() + timedelta(seconds=ATTEMPT_LEASE_SECONDS)
    attempt.driver_kind = driver_kind
    attempt.executor_snapshot_json = {"runtime": dict(runtime)}
    task_run = session.get(AgentTaskRunDB, attempt.task_run_id)
    batch = session.get(AgentTaskBatchRunDB, attempt.batch_run_id)
    if task_run is None or batch is None:
        raise LeaseError("not_found", "attempt references a missing Task Run or Batch")
    task_run.status = "running"
    task_run.started_at = task_run.started_at or attempt.started_at
    batch.status = "running"
    batch.started_at = batch.started_at or attempt.started_at
    session.add(attempt)
    session.add(task_run)
    session.add(batch)
    # the first /start promotes a pending Schedule Occurrence to
    # delivered — from here its outcome belongs to the Batch, not availability.
    _mark_schedule_occurrence_delivered(session, attempt)
    session.commit()
    session.refresh(attempt)
    from apo.services.run_events import emit_task_run_event

    emit_task_run_event(attempt.project, task_run)
    return attempt


def heartbeat_attempt(
    session: Session,
    *,
    lease: CurrentAttemptLease,
    phase: str,
) -> HeartbeatResponse:
    """Renew the current lease and return cancellation state."""
    attempt = _require_current(session, lease)
    if attempt.status not in (LEASED, RUNNING):
        raise LeaseError("state_mismatch", f"cannot heartbeat from status {attempt.status!r}")
    attempt.heartbeat_at = _now()
    attempt.lease_expires_at = _now() + timedelta(seconds=ATTEMPT_LEASE_SECONDS)
    if phase:
        attempt.phase = phase
    session.add(attempt)
    session.commit()
    session.refresh(attempt)
    return HeartbeatResponse(cancel_requested=attempt.cancel_requested_at is not None)


def request_cancellation(session: Session, *, attempt_id: str) -> None:
    """Cancel an Attempt. Queued/leased -> cancelled immediately; running records
    a request (the heartbeat asks the Executor to stop). Idempotent.
    """
    attempt = session.get(TaskExecutionAttemptDB, attempt_id)
    if attempt is None or attempt.status in TERMINAL_STATUSES:
        return
    now = _now()
    if attempt.status in (QUEUED, LEASED):
        attempt.status = CANCELLED
        attempt.cancel_requested_at = now
        attempt.completed_at = now
        _finalize_logical_run(
            session,
            attempt,
            error_message="Execution was cancelled before task code started",
            cancelled=True,
        )
    else:  # running
        attempt.cancel_requested_at = now
    session.add(attempt)
    session.commit()


def recover_expired_attempts(session: Session, *, now: datetime) -> RecoveryCounts:
    """Reaper: requeue safe pre-start leases, fail uncertain post-start leases.

    - leased + lease expired + never started -> queued (re-claimable; next claim
      increments generation);
    - running + lease expired -> lost (never auto-retried);
    - queued + queue TTL expired -> failed(executor_unavailable);
    - terminal -> unchanged.
    """
    requeued = lost = failed_unavailable = 0

    expired_leases = session.exec(
        select(TaskExecutionAttemptDB).where(
            as_column(TaskExecutionAttemptDB.status).in_([LEASED, RUNNING]),
            as_column(TaskExecutionAttemptDB.lease_expires_at) <= now,
        )
    ).all()
    for attempt in expired_leases:
        if attempt.started_at is None:
            # Pre-start: safe to requeue. Drop the lease so another executor can claim.
            attempt.status = QUEUED
            attempt.executor_id = None
            attempt.claimed_at = None
            attempt.lease_expires_at = None
            attempt.heartbeat_at = None
            requeued += 1
        else:
            # Post-start: uncertain; never auto-retry.
            attempt.status = LOST
            attempt.failure_kind = "lease_expired"
            attempt.error_message = (
                "Executor lease expired after task code started; outcome is unknown"
            )
            attempt.completed_at = now
            _finalize_logical_run(
                session,
                attempt,
                error_message=attempt.error_message,
            )
            lost += 1
        session.add(attempt)

    expired_queued = session.exec(
        select(TaskExecutionAttemptDB).where(
            as_column(TaskExecutionAttemptDB.status) == QUEUED,
            as_column(TaskExecutionAttemptDB.queue_expires_at) <= now,
        )
    ).all()
    for attempt in expired_queued:
        attempt.status = FAILED
        attempt.failure_kind = "executor_unavailable"
        attempt.error_message = "queue TTL expired before an executor claimed the task"
        attempt.completed_at = now
        _finalize_logical_run(
            session,
            attempt,
            error_message=attempt.error_message,
        )
        failed_unavailable += 1
        session.add(attempt)

    if requeued or lost or failed_unavailable:
        session.commit()
    return RecoveryCounts(requeued=requeued, lost=lost, failed_unavailable=failed_unavailable)


def fail_attempt(
    session: Session,
    *,
    attempt: TaskExecutionAttemptDB,
    failure_kind: str,
    error_message: str,
) -> TaskExecutionAttemptDB:
    """Mark a non-terminal Attempt failed and align its logical Run state.

    Used by queue maintenance when an Attempt can no longer
    make progress for a non-lease reason (e.g. its Task was removed from
    the published catalog → ``task_not_in_catalog``). Never auto-retries.
    """
    if attempt.status in TERMINAL_STATUSES:
        return attempt
    now = _now()
    attempt.status = FAILED
    attempt.failure_kind = failure_kind
    attempt.error_message = error_message
    attempt.completed_at = now
    session.add(attempt)
    _finalize_logical_run(session, attempt, error_message=error_message)
    session.commit()
    session.refresh(attempt)
    return attempt


def _finalize_logical_run(
    session: Session,
    attempt: TaskExecutionAttemptDB,
    *,
    error_message: str,
    cancelled: bool = False,
) -> None:
    """Keep operational Attempt failure aligned with user-facing Run state."""
    task_run = session.get(AgentTaskRunDB, attempt.task_run_id)
    batch = session.get(AgentTaskBatchRunDB, attempt.batch_run_id)
    if task_run is None or batch is None:
        raise LeaseError("not_found", "attempt references a missing Task Run or Batch")
    if task_run.status in TASK_RUN_TERMINAL:
        return

    now = _now()
    task_run.status = "error"
    task_run.pass_result = None
    task_run.error_message = error_message
    task_run.completed_at = now
    if cancelled:
        batch.cancelled_tasks += 1
    session.add(task_run)
    session.add(batch)
    session.flush()

    from apo.services.agent_task_runner import update_batch_run_status
    from apo.services.run_events import emit_batch_run_event, emit_task_run_event

    update_batch_run_status(session, batch)
    # resolve the pending Schedule Occurrence when the Batch reaches
    # a terminal state through recovery/cancellation.
    from apo.services.schedule_occurrences import resolve_occurrence_if_terminal
    resolve_occurrence_if_terminal(session, batch)
    emit_task_run_event(attempt.project, task_run)
    if batch.status in ("completed", "error"):
        task_runs = list(
            session.exec(
                select(AgentTaskRunDB).where(
                    as_column(AgentTaskRunDB.batch_run_id) == batch.id
                )
            ).all()
        )
        emit_batch_run_event(attempt.project, batch, task_runs)


def _mark_schedule_occurrence_delivered(
    session: Session, attempt: TaskExecutionAttemptDB
) -> None:
    """Promote a pending Schedule Occurrence to delivered on /start."""
    from apo.services.schedule_occurrences import mark_occurrence_delivered_on_start

    mark_occurrence_delivered_on_start(
        session, batch_run_id=attempt.batch_run_id, now=_now()
    )

def cancel_active_batch_on_pause(
    session: Session,
    *,
    schedule: AgentTaskScheduleDB,
    now: datetime,
) -> bool:
    """Pause/delete: cancel the active Batch iff no Task code started.

    Returns True when the Batch was cancelled (pre-start). If any Attempt
    started, the whole Batch is left intact to finish; only the active pointer
    is cleared once normal finalization makes it terminal. Lives here (not in
    ``schedule_occurrences``) to avoid a circular import with ``request_cancellation``.
    """
    if schedule.active_batch_run_id is None:
        return False
    batch = session.get(AgentTaskBatchRunDB, schedule.active_batch_run_id)
    if batch is None:
        schedule.active_batch_run_id = None
        session.add(schedule)
        return False
    if _attempt_started_for_batch(session, batch.id):
        return False

    from apo.services.schedule_occurrences import mark_occurrence_cancelled_for_batch

    # Mark the Occurrence cancelled + clear the pointer BEFORE requesting
    # cancellation so the shared finalization hook sees a non-pending Occurrence.
    mark_occurrence_cancelled_for_batch(session, batch_run_id=batch.id, now=now)
    schedule.active_batch_run_id = None
    session.add(schedule)
    session.flush()
    attempts = session.exec(
        select(TaskExecutionAttemptDB).where(
            TaskExecutionAttemptDB.batch_run_id == batch.id
        )
    ).all()
    for attempt in attempts:
        request_cancellation(session, attempt_id=attempt.id)
    return True


def _attempt_started_for_batch(session: Session, batch_run_id: str) -> bool:
    row = session.exec(
        select(TaskExecutionAttemptDB.id).where(
            TaskExecutionAttemptDB.batch_run_id == batch_run_id,
            as_column(TaskExecutionAttemptDB.started_at).is_not(None),
        ).limit(1)
    ).first()
    return row is not None


__all__ = [
    "CANCELLED",
    "ClaimedAttempt",
    "CurrentAttemptLease",
    "FAILED",
    "HeartbeatResponse",
    "LEASED",
    "LOST",
    "LeaseError",
    "NONTERMINAL_STATUSES",
    "QUEUED",
    "RecoveryCounts",
    "RUNNING",
    "SUCCEEDED",
    "TERMINAL_STATUSES",
    "claim_next_attempt",
    "claim_next_source_owned_attempt",
    "cancel_active_batch_on_pause",
    "fail_attempt",
    "heartbeat_attempt",
    "recover_expired_attempts",
    "request_cancellation",
    "start_attempt",
    "start_lease_reaper",
    "stop_lease_reaper",
]


# ── background reaper (asyncio task; mirrors trace_ingestion_queue) ───────

import asyncio  # noqa: E402

from apo.db import engine  # noqa: E402

_reaper_task: asyncio.Task[None] | None = None
_reaper_stop: asyncio.Event | None = None


async def _run_reaper(stop_event: asyncio.Event) -> None:
    from apo.services.executor_auth import REAPER_INTERVAL_SECONDS

    # Recover interrupted work once at startup (replaces the blanket
    # Recover immediately at startup, then sweep on the configured interval.
    # Issue #177: the sweep is blocking SQL and runs on the same loop that
    # serves /heartbeat — offload it like the other heavy paths (#174) so a
    # slow sweep cannot stall every live run's liveness signal.
    with Session(engine) as session:
        _ = await asyncio.to_thread(recover_expired_attempts, session, now=_now())
        session.commit()
    while not stop_event.is_set():
        try:
            _ = await asyncio.wait_for(
                stop_event.wait(),
                timeout=REAPER_INTERVAL_SECONDS,
            )
        except asyncio.TimeoutError:
            pass
        if stop_event.is_set():
            break
        try:
            with Session(engine) as session:
                _ = await asyncio.to_thread(
                    recover_expired_attempts, session, now=_now()
                )
                session.commit()
        except Exception:
            # A reaper sweep must never crash the background loop.
            pass


def start_lease_reaper() -> None:
    """Start the background lease reaper (idempotent; safe if already running)."""
    global _reaper_task, _reaper_stop
    if _reaper_task is not None and not _reaper_task.done():
        return
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        return  # no running loop (e.g. tests with disabled lifespan)
    _reaper_stop = asyncio.Event()
    _reaper_task = loop.create_task(_run_reaper(_reaper_stop))


async def stop_lease_reaper() -> None:
    """Stop the background lease reaper."""
    global _reaper_task, _reaper_stop
    if _reaper_stop is not None:
        _ = _reaper_stop.set()
    if _reaper_task is not None:
        _ = _reaper_task.cancel()
        try:
            await _reaper_task
        except (asyncio.CancelledError, Exception):
            pass
    _reaper_task = None
    _reaper_stop = None
