"""Slow-request timing: name the endpoint when a request takes seconds.

The backend serves everything on one uvicorn worker with one event loop,
and its history is a chain of fixes where one blocking path (an ingest
write waiting on SQLite's lock, a projection pass, a result
finalization) made every caller wait at once. Each was found by hand
after the fact, because the access log carries no duration: a "the
dashboard was slow yesterday" report had no server-side evidence to
start from.

This middleware closes that gap. Every request whose time from arrival
to response start crosses the threshold is logged as a WARNING naming
the method, the path, the status, and the elapsed milliseconds. Requests
under the threshold cost one ``time.monotonic()`` call and a comparison,
so the check is safe to run on every request.

Two boundaries are deliberate:

  - The path is logged without its query string. Invitation tokens ride
    in query strings, and the access-log redaction exists for exactly
    that; a second log must not open the same hole.
  - The clock stops at response *start*, not body end. SSE and trace
    streams legitimately hold a response open for minutes, and their
    setup cost is what a slow-open report needs to name, not their
    lifetime.
"""

# pyright: reportAny=false, reportImplicitOverride=false, reportUnannotatedClassAttribute=false

from __future__ import annotations

import logging
import os
import time
from collections.abc import Callable

from starlette.types import ASGIApp, Message, Receive, Scope, Send

_logger = logging.getLogger(__name__)

SLOW_REQUEST_MS_ENV = "APO_SLOW_REQUEST_MS"
DEFAULT_SLOW_REQUEST_MS = 1000.0


def load_slow_request_threshold_ms() -> float:
    """Read the warning threshold; a present but invalid value fails startup.

    Same eager contract as the other limit loaders: a typo in the
    variable must stop the process here rather than silently disable the
    timing. ``0`` disables the logging while keeping the middleware
    installed.
    """
    raw = os.environ.get(SLOW_REQUEST_MS_ENV, "").strip()
    if not raw:
        return DEFAULT_SLOW_REQUEST_MS
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(
            f"{SLOW_REQUEST_MS_ENV} must be a number of milliseconds (got {raw!r})"
        ) from exc
    if value < 0:
        raise ValueError(f"{SLOW_REQUEST_MS_ENV} must be >= 0 (got {value})")
    return value


class RequestTimingMiddleware:
    """Log a WARNING when a request crosses the threshold to start responding."""

    def __init__(
        self,
        app: ASGIApp,
        threshold_ms: float = DEFAULT_SLOW_REQUEST_MS,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self.app = app
        self.threshold_ms = threshold_ms
        self._now = now

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or self.threshold_ms <= 0:
            await self.app(scope, receive, send)
            return

        started = self._now()
        response_started = False

        async def timed_send(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start" and not response_started:
                response_started = True
                elapsed_ms = (self._now() - started) * 1000.0
                if elapsed_ms >= self.threshold_ms:
                    _logger.warning(
                        "slow request: %s %s -> %s took %.0f ms to start responding",
                        scope.get("method", "?"),
                        scope.get("path", "?"),
                        message.get("status", "?"),
                        elapsed_ms,
                    )
            await send(message)

        try:
            await self.app(scope, receive, timed_send)
        finally:
            if not response_started:
                elapsed_ms = (self._now() - started) * 1000.0
                if elapsed_ms >= self.threshold_ms:
                    _logger.warning(
                        "slow request: %s %s failed after %.0f ms without responding",
                        scope.get("method", "?"),
                        scope.get("path", "?"),
                        elapsed_ms,
                    )


__all__ = [
    "DEFAULT_SLOW_REQUEST_MS",
    "RequestTimingMiddleware",
    "load_slow_request_threshold_ms",
]
