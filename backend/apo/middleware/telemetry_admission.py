"""Telemetry admission middleware and protected-route registry.

The registry classifies exact method/path pairs as protected telemetry writes.
The middleware (wired INSIDE AuthMiddleware so request.state is populated
when the identity is derived; RequestSize and SecurityHeaders sit outside
both) derives a stable internal identity from the authenticated caller,
consumes request tokens, acquires a concurrency lease, and returns a 429
rate-limit response on rejection.
"""

# pyright: reportImplicitOverride=false, reportUnannotatedClassAttribute=false

from __future__ import annotations

import re
from typing import Literal

from collections.abc import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

from ..services.telemetry_admission import (
    AdmissionRejection,
    TelemetryAdmissionController,
    derive_admission_identity,
)

UnitSource = Literal["spans", "batch", "single", "bulk_scores"]

# Each entry: (method, compiled path pattern, unit source).
# Path parameters use [^/]+ so matching is anchored and exact — a prefix
# such as /api/public/* would incorrectly rate-limit reads.
_PROTECTED_ROUTES: tuple[tuple[str, re.Pattern[str], UnitSource], ...] = (
    ("POST", re.compile(r"^/api/public/otel/v1/traces$"), "spans"),
    ("POST", re.compile(r"^/api/v1/ingestion$"), "batch"),
    ("POST", re.compile(r"^/api/public/ingestion$"), "batch"),
    ("POST", re.compile(r"^/api/v1/traces/[^/]+/scores$"), "single"),
    ("POST", re.compile(r"^/api/v1/observations/[^/]+/scores$"), "single"),
    ("POST", re.compile(r"^/api/v1/scores/bulk$"), "bulk_scores"),
    ("POST", re.compile(r"^/api/public/scores$"), "single"),
)


def is_protected_telemetry_route(method: str, path: str) -> bool:
    """True only for exact method/path matches in the protected-route table."""
    method_u = method.upper()
    for route_method, pattern, _ in _PROTECTED_ROUTES:
        if method_u == route_method and pattern.match(path):
            return True
    return False


class TelemetryAdmissionMiddleware(BaseHTTPMiddleware):
    """Consume request tokens + acquire concurrency for protected telemetry writes."""

    def __init__(self, app: ASGIApp, controller: TelemetryAdmissionController) -> None:
        super().__init__(app)
        self._controller = controller

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if not is_protected_telemetry_route(request.method, request.url.path):
            return await call_next(request)

        identity = derive_admission_identity(request.state)
        if identity is None:
            return _service_unavailable()

        # Store for downstream route-level byte/unit consumption.
        setattr(request.state, "telemetry_identity", identity)

        rejection = self._controller.consume_request(identity)
        if rejection is not None:
            return rate_limit_response(rejection)

        lease_result = self._controller.try_acquire_concurrency()
        if isinstance(lease_result, AdmissionRejection):
            return rate_limit_response(lease_result)

        try:
            return await call_next(request)
        finally:
            lease_result.release()


def rate_limit_response(rejection: AdmissionRejection) -> JSONResponse:
    return JSONResponse(
        status_code=429,
        content={"detail": f"Telemetry {rejection.resource} limit exceeded"},
        headers={
            "Retry-After": str(rejection.retry_after_seconds),
            "X-RateLimit-Limit": str(rejection.limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": str(rejection.retry_after_seconds),
            "X-RateLimit-Resource": rejection.resource,
        },
    )


def _service_unavailable() -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={"detail": "Service temporarily unavailable"},
    )
