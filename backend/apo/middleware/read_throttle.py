"""Read throttle for expensive list/aggregate endpoints.

The telemetry admission middleware bounds *writes* (7 ingest routes), but
the expensive reads — the runs list with span search, the task-run list,
facets — had no limit for authenticated callers: one user (or one leaking
script) could pin the database with repeated heavy queries.

Design mirrors the admission layer's shape but with generous defaults so
the dashboard's polling stays far below the ceiling:

  - sliding-window per identity (the same identity Auth derives: api-key
    id, user id, or client IP fallback)
  - default 120 requests / 60s (env: ``APO_READ_RATE_LIMIT_MAX``,
    ``APO_READ_RATE_LIMIT_WINDOW_SECONDS``; 0 disables)
  - 429 + ``Retry-After`` on excess, for the protected routes below

Wired INSIDE AuthMiddleware (added after it) exactly like the telemetry
admission middleware, so ``request.state`` carries the identity.
"""

# pyright: reportImplicitOverride=false

from __future__ import annotations

import os
import re
import threading
import time
from collections.abc import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

# Exact (method, path) pairs. Only the heavy list/aggregate reads — detail
# reads by id are cheap and stay unthrottled.
_PROTECTED_READS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("GET", re.compile(r"^/v1/runs$")),
    ("GET", re.compile(r"^/v1/runs/facets")),
    ("GET", re.compile(r"^/v1/agent-task-runs$")),
    ("GET", re.compile(r"^/v1/agent-task-batch-runs$")),
)


class ReadThrottle:
    """Sliding-window limiter keyed by caller identity."""

    def __init__(
        self,
        max_requests: int | None = None,
        window_seconds: int | None = None,
    ) -> None:
        self.max_requests = max_requests if max_requests is not None else int(
            os.environ.get("APO_READ_RATE_LIMIT_MAX", "120")
        )
        self.window_seconds = window_seconds if window_seconds is not None else int(
            os.environ.get("APO_READ_RATE_LIMIT_WINDOW_SECONDS", "60")
        )
        self._lock = threading.Lock()
        self._hits: dict[str, list[float]] = {}

    def is_allowed(self, identity: str) -> bool:
        if self.max_requests <= 0:
            return True
        now = time.monotonic()
        cutoff = now - self.window_seconds
        with self._lock:
            hits = [t for t in self._hits.get(identity, []) if t > cutoff]
            if len(hits) >= self.max_requests:
                self._hits[identity] = hits
                return False
            hits.append(now)
            self._hits[identity] = hits
            return True


def _identity_for(request: Request) -> str:
    """The auth identity when present, else the client address."""
    for attr in ("api_key_id", "user_id", "service_task_run_id"):
        value = getattr(request.state, attr, None)
        if value:
            return f"{attr}:{value}"
    if request.client is not None:
        return f"ip:{request.client.host}"
    return "unknown"


class ReadThrottleMiddleware(BaseHTTPMiddleware):
    """Reject excess calls to the protected heavy-read routes with 429."""

    def __init__(self, app, throttle: ReadThrottle) -> None:
        super().__init__(app)
        self._throttle = throttle

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        method = request.method.upper()
        path = request.url.path
        if not any(m == method and p.match(path) for m, p in _PROTECTED_READS):
            return await call_next(request)

        identity = _identity_for(request)
        if self._throttle.is_allowed(identity):
            return await call_next(request)

        return JSONResponse(
            status_code=429,
            content={"detail": "Read rate limit exceeded for this endpoint."},
            headers={
                "Retry-After": str(self._throttle.window_seconds),
                "X-RateLimit-Limit": str(self._throttle.max_requests),
            },
        )
