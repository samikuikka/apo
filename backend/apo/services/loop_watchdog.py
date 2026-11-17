"""Event-loop stall watchdog: log when the serving loop stops turning.

The backend runs a single uvicorn worker, so every request, executor
heartbeat, and SSE frame shares one event loop. One blocking call (sync
SQL waiting on SQLite's write lock, a giant JSON dump, a filesystem hit
on a slow disk) freezes all of them at once, which is exactly the
failure class fixed again and again on the ingest paths. Every one of
those hunts started from a symptom ("leases expired", "the dashboard
hung") with no measurement tying the freeze to a duration.

The watchdog is the measurement. It sleeps in short intervals on the
serving loop itself and reports every interval that opened late. While
the loop is blocked the watchdog cannot run either, so it wakes after
the block ends and reports how long the loop stood still: the detection
and the duration estimate in one log line. The line names no culprit
(the blocked stack is not observable from the loop), but it fixes the
timeline: a stall line followed by slow-request lines from the timing
middleware is the signature of a blocking path; slow requests with no
stall line point at the database or a dependency instead.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time

_logger = logging.getLogger(__name__)

LOOP_STALL_WARN_MS_ENV = "APO_LOOP_STALL_WARN_MS"
DEFAULT_LOOP_STALL_WARN_MS = 500.0

_watchdog_task: asyncio.Task[None] | None = None


def load_loop_stall_warn_ms() -> float:
    """Read the stall threshold; a present but invalid value fails startup.

    Same eager contract as the other limit loaders. ``0`` disables the
    watchdog entirely.
    """
    raw = os.environ.get(LOOP_STALL_WARN_MS_ENV, "").strip()
    if not raw:
        return DEFAULT_LOOP_STALL_WARN_MS
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(
            f"{LOOP_STALL_WARN_MS_ENV} must be a number of milliseconds (got {raw!r})"
        ) from exc
    if value < 0:
        raise ValueError(f"{LOOP_STALL_WARN_MS_ENV} must be >= 0 (got {value})")
    return value


def stalled_seconds(started: float, interval: float, warn_seconds: float) -> float | None:
    """How long the loop stood still during one sleep, if it crossed the threshold.

    The measured oversleep is the stall: anything the loop did instead of
    waking on time is time every other task waited too. Returns ``None``
    under the threshold so the loop body stays a plain ``if``.
    """
    overslept = (time.monotonic() - started) - interval
    if overslept >= warn_seconds:
        return overslept
    return None


async def _watchdog_loop(warn_seconds: float) -> None:
    # Poll at half the warning threshold, clamped so a tiny threshold does
    # not turn the watchdog into a busy loop and a huge one still wakes
    # often enough to bracket short stalls.
    interval = min(1.0, max(0.1, warn_seconds / 2))
    while True:
        started = time.monotonic()
        await asyncio.sleep(interval)
        stall = stalled_seconds(started, interval, warn_seconds)
        if stall is not None:
            _logger.warning(
                "event loop stalled for %.0f ms: every in-flight request waited",
                stall * 1000.0,
            )


def start_loop_watchdog() -> None:
    """Start the watchdog on the running loop. No-op when disabled or running.

    Called from the app lifespan, which owns the serving loop; outside a
    loop there is nothing to watch.
    """
    global _watchdog_task
    warn_ms = load_loop_stall_warn_ms()
    if warn_ms <= 0:
        return
    if _watchdog_task is not None and not _watchdog_task.done():
        return
    _watchdog_task = asyncio.ensure_future(_watchdog_loop(warn_ms / 1000.0))
    _logger.info(
        "event loop stall watchdog started (warn above %.0f ms)", warn_ms
    )


def stop_loop_watchdog() -> None:
    """Cancel the watchdog. Safe to call when never started."""
    global _watchdog_task
    if _watchdog_task is not None:
        _ = _watchdog_task.cancel()
        _watchdog_task = None


__all__ = [
    "DEFAULT_LOOP_STALL_WARN_MS",
    "load_loop_stall_warn_ms",
    "start_loop_watchdog",
    "stop_loop_watchdog",
]
