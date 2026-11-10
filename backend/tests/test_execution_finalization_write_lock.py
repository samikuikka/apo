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
import time
import uuid
from datetime import datetime, timezone

import pytest
from sqlmodel import Session

import apo.services.execution_finalization as fin
from apo.db import begin_immediate, engine
from apo.models.db import ProjectDB, TaskExecutionAttemptDB
from apo.services.execution_finalization import (
    AttemptResultBody,
    finalize_attempt_with_deliverables,
)
from apo.services.execution_leases import CurrentAttemptLease

PRECHECK_SECONDS = 0.5


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
