# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnannotatedClassAttribute=false, reportUnusedParameter=false
"""Issue #177: the lease reaper sweep must not block the event loop.

``_run_reaper`` called ``recover_expired_attempts`` inline on the event
loop. The sweep is a smaller query than a result finalize or an OTLP
ingest, but it holds the same single-writer SQLite lock and runs on the
same loop that serves ``/attempts/{id}/heartbeat`` — a slow sweep delays
the liveness signal of every live run. This pins the same off-loop
contract as #174: the sync sweep runs in a worker thread while the loop
keeps scheduling.
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from typing import Any

import apo.services.execution_leases as leases
import apo.services.executor_auth as executor_auth
from apo.services.execution_leases import _run_reaper

# One full sync stretch. A blocked loop stalls the ticker by this much per
# stretch; an unblocked one keeps beating every ~50 ms.
SYNC_WORK_SECONDS = 1.0


class _FakeSessionCM:
    """Stands in for ``Session(engine)`` so the reaper never touches a DB."""

    def __init__(self, engine: object) -> None:
        self.engine = engine

    def __enter__(self) -> SimpleNamespace:
        return SimpleNamespace(commit=lambda: None)

    def __exit__(self, *exc: object) -> None:
        return None


async def test_reaper_sweep_runs_off_the_event_loop(monkeypatch: Any) -> None:
    calls: list[str] = []

    def slow_recover(session: object, *, now: object) -> object:
        time.sleep(SYNC_WORK_SECONDS)  # the expired-lease sweep SQL
        calls.append("sweep")
        return None

    monkeypatch.setattr(leases, "recover_expired_attempts", slow_recover)
    monkeypatch.setattr(leases, "Session", _FakeSessionCM)
    monkeypatch.setattr(executor_auth, "REAPER_INTERVAL_SECONDS", 1)

    beats: list[float] = []

    async def heartbeat_like_ticker() -> None:
        for _ in range(120):
            beats.append(time.monotonic())
            await asyncio.sleep(0.05)

    stop = asyncio.Event()
    ticker = asyncio.create_task(heartbeat_like_ticker())
    # Let the ticker start beating before the startup sweep begins.
    await asyncio.sleep(0.2)
    reaper = asyncio.create_task(_run_reaper(stop))
    await asyncio.sleep(2.5)
    stop.set()
    await asyncio.wait_for(reaper, timeout=10)
    await ticker

    # Startup sweep plus at least one interval sweep actually overlapped
    # the ticker — otherwise the gap assertion below is vacuous.
    assert len(calls) >= 2, f"only {len(calls)} sweeps ran; test measured nothing"
    gaps = [b - a for a, b in zip(beats, beats[1:])]
    assert max(gaps) < SYNC_WORK_SECONDS, (
        f"event loop stalled during reaper sweep: worst beat gap {max(gaps):.2f}s"
    )


async def _reaper_survives_failed_sweep(monkeypatch: Any, caplog: Any, failing_sweep: int) -> None:
    """One bad row (an Attempt whose Task Run is gone) fails sweep number
    ``failing_sweep``; the reaper logs it and keeps sweeping on its interval."""
    calls: list[str] = []

    def recover(session: object, *, now: object) -> object:
        calls.append("sweep")
        if len(calls) == failing_sweep:
            raise leases.LeaseError("not_found", "attempt references a missing Task Run or Batch")
        return None

    monkeypatch.setattr(leases, "recover_expired_attempts", recover)
    monkeypatch.setattr(leases, "Session", _FakeSessionCM)
    monkeypatch.setattr(executor_auth, "REAPER_INTERVAL_SECONDS", 0.05)

    stop = asyncio.Event()
    reaper = asyncio.create_task(_run_reaper(stop))
    await asyncio.sleep(0.5)
    assert not reaper.done(), reaper.exception()
    stop.set()
    await asyncio.wait_for(reaper, timeout=10)

    assert len(calls) > failing_sweep
    assert "Lease reaper sweep failed" in caplog.text


async def test_a_failed_startup_sweep_does_not_end_the_reaper(
    monkeypatch: Any, caplog: Any
) -> None:
    await _reaper_survives_failed_sweep(monkeypatch, caplog, failing_sweep=1)


async def test_a_failed_interval_sweep_does_not_end_the_reaper(
    monkeypatch: Any, caplog: Any
) -> None:
    await _reaper_survives_failed_sweep(monkeypatch, caplog, failing_sweep=2)
