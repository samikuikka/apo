# pyright: reportAttributeAccessIssue=false, reportPrivateLocalImportUsage=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnusedCallResult=false, reportUnannotatedClassAttribute=false

"""Loop stall watchdog: a blocked serving loop is measured, not guessed."""

from __future__ import annotations

import asyncio
import logging
import re
import time

import pytest

from apo.services import loop_watchdog
from apo.services.loop_watchdog import (
    load_loop_stall_warn_ms,
    stalled_seconds,
)


def test_stalled_seconds_reports_only_threshold_crossings() -> None:
    # The function reads time.monotonic() itself, so the geometry is fixed
    # by "started" lying in the past: a start 0.5 s ago with a 0.1 s
    # interval means the loop stood still for ~0.4 s.
    assert stalled_seconds(
        started=time.monotonic() - 0.5, interval=0.1, warn_seconds=0.05
    ) == pytest.approx(0.4, abs=0.05)
    # Barely over the interval but under the warn threshold: silent.
    assert (
        stalled_seconds(started=time.monotonic() - 0.11, interval=0.1, warn_seconds=0.05)
        is None
    )


def test_watchdog_reports_a_real_block(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        task = asyncio.ensure_future(loop_watchdog._watchdog_loop(0.05))
        await asyncio.sleep(0.02)
        # Block the loop synchronously: the watchdog cannot wake during
        # this, exactly like a blocking call in a handler.
        time.sleep(0.3)
        await asyncio.sleep(0.05)
        task.cancel()

    with caplog.at_level(logging.WARNING, logger="apo.services.loop_watchdog"):
        asyncio.run(scenario())

    stalls = [
        r for r in caplog.records if "event loop stalled" in r.getMessage()
    ]
    assert len(stalls) >= 1
    # The reported stall brackets the block: well over the 50 ms warn
    # threshold, and not more than the whole blocked window.
    reported: list[float] = []
    for record in stalls:
        match = re.search(r"(\d+) ms", record.getMessage())
        if match is not None:
            reported.append(float(match.group(1)))
    assert any(150 <= value <= 350 for value in reported)


def test_watchdog_silent_when_loop_turns(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        task = asyncio.ensure_future(loop_watchdog._watchdog_loop(0.5))
        await asyncio.sleep(0.15)
        task.cancel()

    with caplog.at_level(logging.WARNING, logger="apo.services.loop_watchdog"):
        asyncio.run(scenario())
    assert not [
        r for r in caplog.records if "event loop stalled" in r.getMessage()
    ]


def test_start_is_disabled_at_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APO_LOOP_STALL_WARN_MS", "0")
    loop_watchdog._watchdog_task = None

    async def scenario() -> None:
        loop_watchdog.start_loop_watchdog()
        await asyncio.sleep(0.01)

    asyncio.run(scenario())
    assert loop_watchdog._watchdog_task is None


def test_start_and_stop_cycle(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APO_LOOP_STALL_WARN_MS", "400")

    async def scenario() -> None:
        loop_watchdog.start_loop_watchdog()
        assert loop_watchdog._watchdog_task is not None
        # A second start must not spawn a duplicate watcher.
        first = loop_watchdog._watchdog_task
        loop_watchdog.start_loop_watchdog()
        assert loop_watchdog._watchdog_task is first
        loop_watchdog.stop_loop_watchdog()
        assert loop_watchdog._watchdog_task is None
        # Stopping twice stays safe.
        loop_watchdog.stop_loop_watchdog()

    asyncio.run(scenario())


def test_loader_validates(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("APO_LOOP_STALL_WARN_MS", raising=False)
    assert load_loop_stall_warn_ms() == 500.0
    monkeypatch.setenv("APO_LOOP_STALL_WARN_MS", "soon")
    with pytest.raises(ValueError, match="APO_LOOP_STALL_WARN_MS"):
        load_loop_stall_warn_ms()
    monkeypatch.setenv("APO_LOOP_STALL_WARN_MS", "-1")
    with pytest.raises(ValueError, match="APO_LOOP_STALL_WARN_MS"):
        load_loop_stall_warn_ms()
