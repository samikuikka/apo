"""Request-size and OTLP transport ASGI enforcement.

Wraps the downstream ``receive`` callable so byte limits are enforced BEFORE
Pydantic materializes a body. Counts streamed bytes even when
``Content-Length`` is absent or false (chunked transfers), so a forged or
omitted header cannot bypass the cap.

Extends this to the canonical public OTLP trace path with
configurable limits (``TelemetryTransportLimits``): a hard on-wire byte cap
enforced while streaming, and a receive-only body deadline that does not
constrain persistence or the response stream.

Routes still re-check semantic limits in the service layer so direct service
calls and tests cannot bypass them; this middleware is the network boundary.
"""

# pyright: reportAny=false, reportImplicitOverride=false, reportPrivateUsage=false, reportUnannotatedClassAttribute=false, reportUnusedClass=false

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Message

if TYPE_CHECKING:
    from ..services.telemetry_limits import TelemetryTransportLimits

# §Request and Storage Limits — code constants.
_RESULT_BODY_LIMIT = 10 * 1024 * 1024  # 10 MiB Task result body
_ARTIFACT_UPLOAD_LIMIT = 100 * 1024 * 1024  # 100 MiB per Artifact upload

# the exact canonical public OTLP trace path.
_OTLP_METHOD = "POST"
_OTLP_PATH = "/api/public/otel/v1/traces"


class _BodyTooLarge(Exception):
    """Raised inside the wrapped ``receive`` once the byte cap is exceeded."""


# (method, path prefix, requires suffix, limit). The specific Deliverable
# routes are declared before any future catch-all.
_LIMITED_PATHS: tuple[tuple[str, str, str | None, int], ...] = (
    ("POST", "/v1/agent-task-runs/", "result", _RESULT_BODY_LIMIT),
    ("PUT", "/v1/agent-task-artifact-uploads/", None, _ARTIFACT_UPLOAD_LIMIT),
)


class RequestSizeMiddleware(BaseHTTPMiddleware):
    """Reject bodies that exceed the per-route byte limit before buffering.

    Adds configurable OTLP transport limits (on-wire byte cap +
    receive-only deadline) when ``otlp_limits`` is provided.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        otlp_limits: TelemetryTransportLimits | None = None,
    ) -> None:
        super().__init__(app)
        self._otlp_limits = otlp_limits

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        # 1. Static per-route byte caps.
        limit = _limit_for(request)
        if limit is not None:
            return await _enforce_byte_limit(request, call_next, limit)

        # 2. Configurable OTLP transport limits.
        if self._otlp_limits is not None and _is_otlp_request(request):
            return await _enforce_otlp_limits(request, call_next, self._otlp_limits)

        return await call_next(request)


def _is_otlp_request(request: Request) -> bool:
    return request.method.upper() == _OTLP_METHOD and request.url.path == _OTLP_PATH


async def _enforce_byte_limit(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
    limit: int,
) -> Response:
    """Streamed byte-cap enforcement for static per-route limits."""
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            declared_size = int(declared)
        except ValueError:
            return _too_large(limit)
        if declared_size > limit:
            return _too_large(limit)

    receive = request.receive
    received = 0

    async def sized_receive() -> Message:
        nonlocal received
        message = await receive()
        if message.get("type") == "http.request":
            body = message.get("body", b"")
            received += len(body) if isinstance(body, (bytes, bytearray)) else 0
            if received > limit:
                raise _BodyTooLarge()
        return message

    request._receive = sized_receive  # type: ignore[attr-defined]
    try:
        return await call_next(request)
    except _BodyTooLarge:
        return _too_large(limit)


async def _enforce_otlp_limits(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
    limits: TelemetryTransportLimits,
) -> Response:
    """Streamed on-wire cap + receive-only deadline for the OTLP path.

    Pre-reads the body in the middleware itself (counting bytes and enforcing
    the deadline) rather than wrapping ``receive`` with an exception-raising
    callable. This avoids conflicts with ``BaseHTTPMiddleware``'s internal
    body-forwarding task, which calls ``request._receive`` on a separate path
    that bypasses ``call_next``'s exception handling.
    """
    max_bytes = limits.max_request_bytes
    deadline_s = limits.body_timeout_seconds

    # Declared Content-Length check — reject without reading.
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > max_bytes:
                return _too_large(max_bytes)
        except ValueError:
            return _too_large(max_bytes)

    # Pre-read the body with streaming byte counting + receive deadline.
    underlying = request.receive
    body = bytearray()
    start: float | None = None

    while True:
        if start is None:
            start = time.monotonic()
        remaining = deadline_s - (time.monotonic() - start)
        if remaining <= 0:
            return _request_timeout()
        try:
            message = await asyncio.wait_for(underlying(), timeout=remaining)
        except asyncio.TimeoutError:
            return _request_timeout()

        mtype = message.get("type", "")
        if mtype == "http.disconnect":
            return JSONResponse(status_code=499, content={"detail": "client disconnected"})
        if mtype != "http.request":
            continue

        chunk = message.get("body", b"")
        body.extend(chunk)
        if len(body) > max_bytes:
            return _too_large(max_bytes)
        if not message.get("more_body", False):
            break

    body_bytes = bytes(body)
    setattr(request.state, "telemetry_received_bytes", len(body_bytes))

    # Replay the pre-read body for the downstream route handler. The body is
    # fully within limits, so the route gets the complete payload in one shot.
    done = False

    async def replay_receive() -> Message:
        nonlocal done
        if not done:
            done = True
            return {"type": "http.request", "body": body_bytes, "more_body": False}
        return {"type": "http.disconnect"}

    request._receive = replay_receive  # type: ignore[attr-defined]
    return await call_next(request)


def _limit_for(request: Request) -> int | None:
    method = request.method.upper()
    path = request.url.path
    for lim_method, prefix, suffix, limit in _LIMITED_PATHS:
        if method != lim_method or not path.startswith(prefix):
            continue
        if suffix is not None and not path.endswith(suffix):
            continue
        return limit
    return None


def _too_large(limit: int) -> JSONResponse:
    return JSONResponse(
        status_code=413,
        content={"detail": f"Request body exceeds the {limit} byte limit"},
    )


def _request_timeout() -> JSONResponse:
    return JSONResponse(
        status_code=408,
        content={"detail": "Request body receive deadline exceeded"},
    )
