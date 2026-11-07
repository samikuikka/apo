"""Aggregate request budget across every route.

The read throttle caps 8 heavy list/aggregate reads per identity, and
telemetry admission caps 5 telemetry write routes, but nothing bounded the
TOTAL request rate: hundreds of pollers with distinct identities (attempt
tokens, executors) or a fleet sharing one API key each stay under every
per-identity ceiling while their combined request rate saturates the
backend's CPU.

This budget is the aggregate backstop. One global token bucket bounds all
callers combined; one per-identity token bucket bounds each authenticated
caller. Both reuse the TelemetryAdmissionController engine, so the cost
per request is a single lock-guarded bucket check, which adds no
meaningful latency.

Defaults are deliberately generous so normal traffic stays far below the
ceiling: dashboard polling, task clients flushing ~2 requests/s per run,
and executor heartbeats all fit inside one identity's budget with room
to spare.

Unauthenticated traffic (executor protocol, public auth routes) counts
into the global bucket only: derive_admission_identity would return the
synthetic identity "open-dev" for it, so this middleware only derives an
identity for requests whose auth_method is actually set. The one shared
exception is anonymous-demo traffic (auth_method "anonymous"), which
derives "open-dev" and is bounded as a single tenant, mirroring the
telemetry admission middleware.
"""

# pyright: reportImplicitOverride=false

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

from ..services.telemetry_admission import (
    AdmissionRejection,
    TelemetryAdmissionController,
    derive_admission_identity,
)
from ..services.telemetry_limits import TokenBucketPolicy


@dataclass(frozen=True)
class RequestBudgetLimits:
    """The budget's two dimensions; None disables that dimension.

    Both None means the whole budget is off and the middleware is not
    wired at all.
    """

    identity: TokenBucketPolicy | None
    global_requests: TokenBucketPolicy | None


def load_request_budget_limits() -> RequestBudgetLimits:
    """Load and validate the request budget from the environment.

    Reads each variable at call time (not import time) so tests and app
    construction see current values. ``0`` for either variable of a
    dimension disables that dimension. Raises :class:`ValueError` naming
    the variable on an empty, non-integer, or negative value.
    """
    return RequestBudgetLimits(
        identity=_load_policy(
            "APO_REQUEST_BUDGET_IDENTITY_PER_MINUTE",
            3600,
            "APO_REQUEST_BUDGET_IDENTITY_BURST",
            600,
        ),
        global_requests=_load_policy(
            "APO_REQUEST_BUDGET_GLOBAL_PER_MINUTE",
            12_000,
            "APO_REQUEST_BUDGET_GLOBAL_BURST",
            2000,
        ),
    )


class RequestBudgetMiddleware(BaseHTTPMiddleware):
    """Bound total request rate with a global plus per-identity budget."""

    def __init__(
        self,
        app: ASGIApp,
        controller: TelemetryAdmissionController,
        limits: RequestBudgetLimits,
    ) -> None:
        super().__init__(app)
        self._controller: TelemetryAdmissionController = controller
        self._limits: RequestBudgetLimits = limits

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if request.method.upper() == "OPTIONS":
            return await call_next(request)
        # The Compose healthcheck polls /health/ready; a 429 there would
        # mark the container unhealthy and trigger a restart loop, so
        # health probes never draw from the budget.
        path = request.url.path
        if path == "/health" or path.startswith("/health/"):
            return await call_next(request)

        identity = _authenticated_identity(request)
        rejection = self._consume(identity)
        if rejection is not None:
            return _budget_response(rejection)
        return await call_next(request)

    def _consume(self, identity: str | None) -> AdmissionRejection | None:
        # A disabled dimension is never charged. With both dimensions live
        # and a real identity, the paired consume charges the identity AND
        # global buckets atomically, so no second charge may follow it.
        if identity is None:
            if self._limits.global_requests is not None:
                return self._controller.consume_request_global()
            return None
        identity_live = self._limits.identity is not None
        global_live = self._limits.global_requests is not None
        if identity_live and global_live:
            return self._controller.consume_request(identity)
        if identity_live:
            return self._controller.consume_request_identity(identity)
        if global_live:
            return self._controller.consume_request_global()
        return None


def _authenticated_identity(request: Request) -> str | None:
    """The admission identity, but only for requests that carry one.

    derive_admission_identity returns the synthetic "open-dev" when
    auth_method is unset; requests with no auth state at all must stay
    global-only, so gate on auth_method first. Anonymous-demo requests
    (auth_method "anonymous") pass the gate deliberately and derive the
    shared "open-dev" identity: the demo is one tenant. An authenticated
    request whose subject cannot be derived (None) also falls back to
    global-only rather than inventing an identity.
    """
    if not getattr(request.state, "auth_method", None):
        return None
    return derive_admission_identity(request.state)


def _budget_response(rejection: AdmissionRejection) -> JSONResponse:
    return JSONResponse(
        status_code=429,
        content={"detail": "Request rate limit exceeded"},
        headers={
            "Retry-After": str(rejection.retry_after_seconds),
            "X-RateLimit-Limit": str(rejection.limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Resource": rejection.resource,
            "X-RateLimit-Scope": rejection.scope,
        },
    )


def _load_policy(
    rate_var: str,
    rate_default: int,
    burst_var: str,
    burst_default: int,
) -> TokenBucketPolicy | None:
    """One dimension of the budget; None (disabled) when either value is 0."""
    rate = _parse_budget_int(rate_var, os.environ.get(rate_var), rate_default)
    burst = _parse_budget_int(burst_var, os.environ.get(burst_var), burst_default)
    if rate == 0 or burst == 0:
        return None
    return TokenBucketPolicy(tokens_per_minute=rate, burst=burst)


def _parse_budget_int(name: str, raw: str | None, default: int) -> int:
    """Parse one budget env var.

    Missing means default. ``0`` is valid (the caller disables that
    dimension). Present empty, non-integer, or negative raises
    :class:`ValueError` naming only ``name``, failing startup fast.
    """
    if raw is None:
        return default
    text = raw.strip()
    if text == "":
        raise ValueError(f"{name} must be a non-negative integer (got empty)")
    try:
        value = int(text)
    except ValueError:
        raise ValueError(
            f"{name} must be a non-negative base-10 integer (got {text!r})"
        ) from None
    if value < 0:
        raise ValueError(f"{name} must be a non-negative integer (got {value})")
    return value
