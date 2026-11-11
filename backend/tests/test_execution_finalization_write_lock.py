# pyright: reportAny=false, reportUnusedCallResult=false

"""Result finalization must not hold SQLite's write lock across loop awaits.

The executor heartbeat routes are ``async def`` and write on the event loop.
A sync write that finds the write lock taken waits in SQLite's busy handler
for ``busy_timeout``, on the loop thread. When the lock's holder is a
coroutine that needs that same loop to continue (finalization between its
worker-thread stretches), neither side can move: the service is frozen,
``/health`` included, until the waiter times out with "database is locked".
"""

from __future__ import annotations

import asyncio
import threading
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import Session

import apo.services.execution_finalization as fin
from apo.db import begin_immediate, engine
from apo.models.db import AgentTaskResultEvidenceDB, ProjectDB, TaskExecutionAttemptDB
from apo.services.execution_finalization import (
    AttemptResultBody,
    finalize_attempt_with_deliverables,
)
from apo.services.execution_leases import CurrentAttemptLease
from apo.services.result_evidence import delete_result_evidence

PRECHECK_SECONDS = 0.5
LOCK_HOLD_SECONDS = 0.6


def _heartbeat_like_write() -> float:
    """A sync write on the calling thread, as the heartbeat routes do."""
    started = time.monotonic()
    with Session(engine) as session:
        project_id = f"lock-{uuid.uuid4().hex[:8]}"
        session.add(ProjectDB(id=project_id, name=project_id))
        session.commit()
    return time.monotonic() - started


async def test_loop_side_write_is_not_starved_while_a_result_finalizes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def slow_precheck(
        session: Session, *, lease: CurrentAttemptLease, body: AttemptResultBody
    ) -> bool:
        time.sleep(PRECHECK_SECONDS)
        return False

    def finalize(
        session: Session,
        *,
        lease: CurrentAttemptLease,
        body: AttemptResultBody,
        completion_digest: str | None = None,
    ) -> TaskExecutionAttemptDB:
        begin_immediate(session)
        session.commit()
        return TaskExecutionAttemptDB(
            project="p",
            batch_run_id="b",
            task_run_id="r",
            sequence_index=0,
            target_kind="caller",
            queue_expires_at=datetime.now(timezone.utc),
        )

    monkeypatch.setattr(fin, "precheck_result_replay", slow_precheck)
    monkeypatch.setattr(fin, "finalize_attempt_result", finalize)

    with Session(engine) as session:
        finalization = asyncio.create_task(
            finalize_attempt_with_deliverables(
                session,
                lease=CurrentAttemptLease(attempt_id="att", lease_generation=1, executor_id=""),
                body=AttemptResultBody(completion_id="c", pass_result=True),
                deliverables=None,
            )
        )
        # Finalization is now inside its precheck worker thread.
        await asyncio.sleep(PRECHECK_SECONDS / 5)
        waited = _heartbeat_like_write()
        assert await finalization is not None

    assert waited < 1.0, f"a loop-side write waited {waited:.1f}s on the finalization's write lock"


def _seed_running_attempt() -> str:
    """A leased, running attempt on the shared file engine; returns its id."""
    from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB, UserDB

    attempt_id = f"att-{uuid.uuid4().hex[:8]}"
    suffix = attempt_id[-8:]
    with Session(engine) as s:
        u = UserDB(email=f"o-{suffix}@t.com", name="O", password_hash="x", is_active=True)
        s.add(u)
        s.commit()
        s.refresh(u)
        project = f"prj-{suffix}"
        s.add(ProjectDB(id=project, name=project, created_by=u.id))
        batch = AgentTaskBatchRunDB(
            id=f"bch-{suffix}", project=project, selection_type="tasks", status="queued",
            execution_target_json={"kind": "source_owned"}, created_at=datetime.now(timezone.utc),
        )
        s.add(batch)
        s.flush()
        s.add(AgentTaskRunDB(
            id=f"run-{suffix}", batch_run_id=batch.id, task_id="t", task_path="p",
            sequence_index=0, status="pending",
        ))
        s.flush()
        s.add(TaskExecutionAttemptDB(
            id=attempt_id, project=project, batch_run_id=batch.id,
            task_run_id=f"run-{suffix}", sequence_index=0, target_kind="pool",
            assignment_kind="source_owned", status="running", phase="running",
            queue_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            lease_generation=1,
            lease_expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
        ))
        s.commit()
    return attempt_id


async def test_result_survives_a_concurrent_commit_during_precheck(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The precheck's read snapshot must not ride into the finalize write.

    The precheck reads open a DEFERRED transaction on the request session.
    If that transaction is still open when finalize writes, the write is a
    WAL snapshot upgrade: any writer that committed while the digest was
    churning (the projector does, constantly) fails the whole result
    instantly with SQLITE_BUSY_SNAPSHOT — busy_timeout is never consulted
    and the executor gets a 500 instead of a finalized attempt.
    """
    attempt_id = _seed_running_attempt()

    real_digest = fin._body_digest
    fired = False

    def digest_with_concurrent_writer(payload: object) -> str:
        nonlocal fired
        if not fired:
            fired = True
            projector = f"prj-snap-{uuid.uuid4().hex[:8]}"
            with Session(engine) as other:
                other.add(ProjectDB(id=projector, name=projector))
                other.commit()
        return real_digest(payload)  # pyright: ignore[reportUnusedCallResult]

    monkeypatch.setattr(fin, "_body_digest", digest_with_concurrent_writer)

    with Session(engine) as session:
        finalized = await finalize_attempt_with_deliverables(
            session,
            lease=CurrentAttemptLease(attempt_id=attempt_id, lease_generation=1, executor_id=""),
            body=AttemptResultBody(completion_id="c-snap", pass_result=True),
            deliverables=None,
        )

    assert finalized is not None
    with Session(engine) as s:
        attempt = s.get(TaskExecutionAttemptDB, attempt_id)
        assert attempt is not None
        assert attempt.status == "succeeded"


def _hold_write_lock(taken: threading.Event) -> None:
    with Session(engine) as session:
        begin_immediate(session)
        taken.set()
        time.sleep(LOCK_HOLD_SECONDS)
        session.rollback()


async def _stall_while(write: Callable[[], Awaitable[object]]) -> float:
    """Run ``write`` behind a held write lock; return the longest loop gap.

    ``write`` must be a factory so the coroutine is created (and first
    scheduled) only after the lock is held — a task created earlier runs
    during the lock-acquisition await and never sees contention.
    """
    taken = threading.Event()
    holder = threading.Thread(target=_hold_write_lock, args=(taken,))
    holder.start()
    assert await asyncio.to_thread(taken.wait, 5)

    longest = 0.0
    watching = True

    async def watch() -> None:
        nonlocal longest
        last = time.monotonic()
        while watching:
            await asyncio.sleep(0.01)
            now = time.monotonic()
            longest = max(longest, now - last)
            last = now

    watcher = asyncio.create_task(watch())
    await asyncio.sleep(0)
    try:
        await write()
    finally:
        watching = False
        await watcher
        await asyncio.to_thread(holder.join)
    return longest


async def test_deliverables_write_waits_off_the_loop() -> None:
    """The deliverables stretch writes (storage counter, rows) mid-finalization.

    Those writes wait for SQLite's write lock behind any running projection
    batch. Waiting on the event loop freezes the service for as long; the
    stretch must wait in a worker thread instead.
    """
    attempt_id = _seed_running_attempt()
    with Session(engine) as session:
        stall = await _stall_while(
            lambda: finalize_attempt_with_deliverables(
                session,
                lease=CurrentAttemptLease(
                    attempt_id=attempt_id, lease_generation=1, executor_id=""
                ),
                body=AttemptResultBody(completion_id="c-deliv", pass_result=True),
                deliverables={"answer": {"value": 42}},
            )
        )

    assert stall < LOCK_HOLD_SECONDS / 2, (
        f"the event loop stopped for {stall:.2f}s behind the write lock"
    )
    with Session(engine) as s:
        attempt = s.get(TaskExecutionAttemptDB, attempt_id)
        assert attempt is not None
        assert attempt.status == "succeeded"


async def test_evidence_cleanup_waits_off_the_loop() -> None:
    """Staging cleanup deletes rows after the result is recorded.

    The DELETEs wait for SQLite's write lock like any write; from the event
    loop that wait freezes the service. They must run off the loop.
    """
    attempt_id = _seed_running_attempt()
    with Session(engine) as s:
        attempt = s.get(TaskExecutionAttemptDB, attempt_id)
        assert attempt is not None
        s.add(AgentTaskResultEvidenceDB(
            id=f"ev-{uuid.uuid4().hex[:8]}", project=attempt.project,
            attempt_id=attempt_id, task_run_id=attempt.task_run_id,
            slot="transcript", status="ready", size_bytes=1, sha256="0" * 64,
            created_at=datetime.now(timezone.utc),
        ))
        s.commit()

    with Session(engine) as session:
        stall = await _stall_while(
            lambda: delete_result_evidence(session, attempt_id=attempt_id)
        )

    assert stall < LOCK_HOLD_SECONDS / 2, (
        f"the event loop stopped for {stall:.2f}s behind the write lock"
    )
