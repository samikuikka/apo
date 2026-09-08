"""Request-size and OTLP transport ASGI enforcement.

Byte limits are enforced BEFORE Pydantic materializes a body: the
middleware pre-reads the request body while counting bytes — so a forged
or omitted ``Content-Length`` (chunked transfers) cannot bypass the cap —
then replays the in-limit body to the route.

Covers two tiers:

- Static per-route caps on write paths (task-run results, artifact
  uploads, executor-protocol submissions, judgments, comments, run
  writes), configurable via ``RequestBodyLimits`` env knobs.
- The canonical public OTLP trace path with
  ``TelemetryTransportLimits``: a hard on-wire byte cap plus a
  receive-only body deadline that does not constrain persistence or the
  response stream.

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
    from ..services.request_body_limits import RequestBodyLimits
    from ..services.telemetry_limits import TelemetryTransportLimits

# §Request and Storage Limits — defaults for constructions without explicit
# limits (values match the shipped defaults of load_request_body_limits).
_RESULT_BODY_LIMIT = 10 * 1024 * 1024  # 10 MiB Task result body
_ARTIFACT_UPLOAD_LIMIT = 100 * 1024 * 1024  # 100 MiB per Artifact upload
_WRITE_BODY_LIMIT = 10 * 1024 * 1024  # 10 MiB other write bodies
_RESULT_EVIDENCE_LIMIT = 100 * 1024 * 1024  # 100 MiB per result-evidence part

# the exact canonical public OTLP trace path.
_OTLP_METHOD = "POST"
_OTLP_PATH = "/api/public/otel/v1/traces"


# (method, path prefix, requires suffix). The specific Deliverable
# routes are declared before any future catch-all. Limits come from
# RequestBodyLimits; the suffix is an ``endswith`` match, so
# ``test-result-corrections`` never trips the ``result`` entries and
# ``result-evidence`` intents get the small-body write cap rather than
# falling through unlimited.
_LIMITED_PATH_SPECS: tuple[tuple[str, str, str | None], ...] = (
    ("POST", "/v1/agent-task-runs/", "result"),
    ("PUT", "/v1/agent-task-artifact-uploads/", None),
    # Executor submissions and the other member-write bodies share one cap:
    # oversized SDK submissions must die at the boundary, not in memory.
    ("POST", "/v1/executor-protocol/v1/attempts/", "result-evidence"),
    ("POST", "/v1/executor-protocol/v2/attempts/", "result-evidence"),
    ("POST", "/v1/executor-protocol/v1/attempts/", "result"),
    ("POST", "/v1/executor-protocol/v1/attempts/", "failure"),
    ("POST", "/v1/executor-protocol/v2/attempts/", "result"),
    ("POST", "/v1/executor-protocol/v2/attempts/", "failure"),
    # Result-evidence part bytes (issue #251): their own cap, artifact-upload
    # magnitude, keyed by the version-neutral PUT path.
    ("PUT", "/v1/executor-protocol/result-evidence/", None),
    ("POST", "/v1/agent-task-runs/", "judgments"),
    ("POST", "/api/v1/comments", None),
    # Prefix match also covers /{run_id}/custom-metrics, /bulk-delete,
    # /bulk-export, /reproject — all small-body POSTs.
    ("POST", "/v1/runs", None),
)

_LimitedPath = tuple[str, str, str | None, int]


def _limited_paths(
    result_limit: int,
    artifact_limit: int,
    write_limit: int,
    result_evidence_limit: int = _RESULT_EVIDENCE_LIMIT,
) -> tuple[_LimitedPath, ...]:
    """Resolve path specs against the active limits.

    ``result``-suffixed entries use the result limit, artifact upload and
    result-evidence PUTs their own, everything else the shared write limit.
    """
    resolved: list[_LimitedPath] = []
    for method, prefix, suffix in _LIMITED_PATH_SPECS:
        if suffix == "result" and prefix == "/v1/agent-task-runs/":
            limit = result_limit
        elif prefix == "/v1/agent-task-artifact-uploads/":
            limit = artifact_limit
        elif prefix == "/v1/executor-protocol/result-evidence/":
            limit = result_evidence_limit
        else:
            limit = write_limit
        resolved.append((method, prefix, suffix, limit))
    return tuple(resolved)


class RequestSizeMiddleware(BaseHTTPMiddleware):
    """Reject bodies that exceed the per-route byte limit before buffering.

    Per-route byte caps come from ``body_limits`` (env-tunable via
    ``load_request_body_limits``); constructing without limits keeps the
    shipped defaults. Adds configurable OTLP transport limits (on-wire
    byte cap + receive-only deadline) when ``otlp_limits`` is provided.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        otlp_limits: TelemetryTransportLimits | None = None,
        body_limits: RequestBodyLimits | None = None,
    ) -> None:
        super().__init__(app)
        self._otlp_limits = otlp_limits
        if body_limits is not None:
            self._limited_paths = _limited_paths(
                body_limits.result_max_bytes,
                body_limits.artifact_upload_max_bytes,
                body_limits.write_max_bytes,
                body_limits.result_evidence_max_bytes,
            )
        else:
            self._limited_paths = _limited_paths(
                _RESULT_BODY_LIMIT, _ARTIFACT_UPLOAD_LIMIT, _WRITE_BODY_LIMIT
            )

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        # 1. Static per-route byte caps.
        limit = _limit_for(request, self._limited_paths)
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
    """Pre-read the body counting bytes, then replay it downstream.

    Enforcement happens in the middleware itself rather than by wrapping
    ``receive`` with an exception-raising callable: BaseHTTPMiddleware's
    internal body-forwarding task calls ``request._receive`` on a path
    that bypasses ``call_next``'s exception handling, so a raise from the
    wrapper escapes as an unhandled error instead of a 413 (the same
    lesson the OTLP path was built on).
    """
    # Declared Content-Length check — reject without reading.
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > limit:
                return _too_large(limit)
        except ValueError:
            return _too_large(limit)

    body = bytearray()
    while True:
        message = await request.receive()
        mtype = message.get("type", "")
        if mtype == "http.disconnect":
            break
        if mtype != "http.request":
            continue
        body.extend(message.get("body", b""))
        if len(body) > limit:
            return _too_large(limit)
        if not message.get("more_body", False):
            break

    body_bytes = bytes(body)

    # Replay the pre-read body; a client that disconnected mid-body still
    # surfaces the disconnect to the downstream handler, as before.
    sent_body = False

    async def replay_receive() -> Message:
        nonlocal sent_body
        if not sent_body:
            sent_body = True
            return {"type": "http.request", "body": body_bytes, "more_body": False}
        return {"type": "http.disconnect"}

    request._receive = replay_receive  # type: ignore[attr-defined]
    return await call_next(request)


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


def _limit_for(request: Request, limited_paths: tuple[_LimitedPath, ...]) -> int | None:
    method = request.method.upper()
    path = request.url.path
    for lim_method, prefix, suffix, limit in limited_paths:
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
