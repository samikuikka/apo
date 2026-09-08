"""Issue #174: /result finalization must not block the event loop.

The finalization path does seconds of sync work (body digest + SQL writes)
over multi-MB result bodies. When that ran directly on the event loop, one
heavy finalize froze heartbeats and every other request behind it for its
whole duration. This pins the off-loop contract: the sync helpers run in a
worker thread while the loop keeps scheduling.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone

from sqlmodel import Session

import apo.services.execution_finalization as fin
from apo.models.db import TaskExecutionAttemptDB
from apo.services.execution_finalization import (
    AttemptResultBody,
    finalize_attempt_with_deliverables,
)
from apo.services.execution_leases import CurrentAttemptLease

# One full sync stretch. A blocked loop stalls the ticker by this much per
# stretch; an unblocked one keeps beating every ~50 ms.
SYNC_WORK_SECONDS = 1.0


def _stub_attempt() -> TaskExecutionAttemptDB:
    return TaskExecutionAttemptDB(
        project="p",
        batch_run_id="b",
        task_run_id="r",
        sequence_index=0,
        target_kind="caller",
        queue_expires_at=datetime.now(timezone.utc),
    )


async def test_result_finalization_runs_off_the_event_loop(
    session: Session, monkeypatch: object
) -> None:
    calls: list[str] = []

    def slow_precheck(
        session: Session, *, lease: CurrentAttemptLease, body: AttemptResultBody
    ) -> bool:
        time.sleep(SYNC_WORK_SECONDS)  # the heavy digest + idempotency SQL
        calls.append("precheck")
        return False

    def slow_finalize(
        session: Session,
        *,
        lease: CurrentAttemptLease,
        body: AttemptResultBody,
        completion_digest: str | None = None,
    ) -> TaskExecutionAttemptDB:
        time.sleep(SYNC_WORK_SECONDS)  # the heavy finalization write
        calls.append("finalize")
        return _stub_attempt()

    monkeypatch.setattr(fin, "precheck_result_replay", slow_precheck)  # type: ignore[attr-defined]
    monkeypatch.setattr(fin, "finalize_attempt_result", slow_finalize)  # type: ignore[attr-defined]

    beats: list[float] = []

    async def heartbeat_like_ticker() -> None:
        for _ in range(60):
            beats.append(time.monotonic())
            await asyncio.sleep(0.05)

    ticker = asyncio.create_task(heartbeat_like_ticker())
    # Let the ticker start beating before the sync stretches begin, so the
    # beats actually overlap finalization either way.
    await asyncio.sleep(0.2)
    attempt = await finalize_attempt_with_deliverables(
        session,
        lease=CurrentAttemptLease(attempt_id="att", lease_generation=1, executor_id=""),
        body=AttemptResultBody(completion_id="c", pass_result=True),
        deliverables=None,
    )
    await ticker

    assert attempt is not None
    assert calls == ["precheck", "finalize"]
    gaps = [b - a for a, b in zip(beats, beats[1:])]
    assert max(gaps) < SYNC_WORK_SECONDS, (
        f"event loop stalled during finalization: worst beat gap {max(gaps):.2f}s"
    )
