"""Aggregate request budget across every route.

The read throttle caps the heavy list/aggregate reads per identity, and
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

Public paths (the health probe, the auth routes, the self-authenticating
executor protocol: every path AuthMiddleware's public-path check admits)
skip auth entirely, so their requests carry no identity. Charging those
to the global bucket let one anonymous address flood the health probe,
empty the installation-wide bucket, and 429 every route for every
caller. A public-path request attributable to a client address is
therefore bounded by a per-address sliding window instead
(``APO_PUBLIC_PATH_REQUESTS_PER_MINUTE``, default 120/min; 0 disables
it) and charges nothing shared: each address can only lock out itself.

Every other request without an identity keeps the legacy global-only
charge. That covers the development-profile open-dev bypass, and
public-path requests with no attributable address: a trusted peer that
forwarded no client address is the installation's own server-side call
(the dashboard server verifying a password, say), and keying those by
the peer would put every visitor into one bucket. Anonymous-demo traffic
(auth_method "anonymous") still derives "open-dev" and is bounded as a
single tenant, mirroring the telemetry admission middleware.
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

from ..auth.client_ip import get_external_client_ip

# Which paths are public is auth's knowledge. Reusing its own predicate
# (not a copied path list) keeps the per-address window and the auth
# allow-list from drifting: a route made public later is covered at once.
from ..auth.middleware import _is_public  # pyright: ignore[reportPrivateUsage]
from ..auth.rate_limit import LoginRateLimiter
from ..services.telemetry_admission import (
    AdmissionRejection,
    TelemetryAdmissionController,
    derive_admission_identity,
)
from ..services.telemetry_limits import TokenBucketPolicy


@dataclass(frozen=True)
class RequestBudgetLimits:
    """The budget's dimensions; None disables that dimension.

    All three None means the whole budget is off and the middleware is
    not wired at all. ``public_path_per_ip`` is not a token bucket: it
    is the sliding-window size (requests per 60s) applied per source
    address to public-path traffic.
    """

    identity: TokenBucketPolicy | None
    global_requests: TokenBucketPolicy | None
    public_path_per_ip: int | None = None


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
        public_path_per_ip=_load_public_path_per_ip(),
    )


class RequestBudgetMiddleware(BaseHTTPMiddleware):
    """Bound request rate: global plus per-identity, per-address on public paths."""

    def __init__(
        self,
        app: ASGIApp,
        controller: TelemetryAdmissionController,
        limits: RequestBudgetLimits,
    ) -> None:
        super().__init__(app)
        self._controller: TelemetryAdmissionController = controller
        self._limits: RequestBudgetLimits = limits
        self._public_limiter: LoginRateLimiter | None = (
            LoginRateLimiter(
                max_attempts=limits.public_path_per_ip, window_seconds=60
            )
            if limits.public_path_per_ip is not None
            else None
        )

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
        if identity is None and self._public_limiter is not None and _is_public(path):
            # None = the installation's own server-side call: no client
            # address to meter, so it keeps the legacy charge below.
            address = get_external_client_ip(request)
            if address is not None:
                return await self._dispatch_public(
                    request, call_next, self._public_limiter, address
                )
        rejection = self._consume(identity)
        if rejection is not None:
            return _budget_response(rejection)
        return await call_next(request)

    async def _dispatch_public(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
        limiter: LoginRateLimiter,
        address: str,
    ) -> Response:
        """Public-path traffic: one sliding window per client address.

        Public paths skip auth, so their requests have no identity and
        no identity bucket; charging them the global bucket is the
        drain-the-budget-for-everyone vector (an anonymous flood on the
        health probe empties the one bucket every caller shares). On the
        window they charge nothing shared: each address can only lock
        out itself.
        """
        if not limiter.allow_and_record(address):
            return _public_limit_response(limiter, address)
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
    off the identity dimension (the per-address window when they are
    attributable public-path requests, global-only otherwise), so gate
    on auth_method first. Anonymous-demo requests (auth_method
    "anonymous") pass the gate deliberately and derive the shared
    "open-dev" identity: the demo is one tenant. An authenticated
    request whose subject cannot be derived (None) is treated as
    identity-less too rather than inventing an identity.
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


def _public_limit_response(limiter: LoginRateLimiter, address: str) -> JSONResponse:
    """The budget's 429 shape for an address that exhausted its window.

    Same header set as ``_budget_response`` so clients parse one shape;
    scope "ip" tells a caller the limit is its own address, not a
    saturated backend.
    """
    return JSONResponse(
        status_code=429,
        content={
            "detail": "Public path request rate limit exceeded for this address."
        },
        headers={
            "Retry-After": str(limiter.get_retry_after(address)),
            "X-RateLimit-Limit": str(limiter.max_attempts),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Resource": "public-requests",
            "X-RateLimit-Scope": "ip",
        },
    )


def _load_public_path_per_ip() -> int | None:
    """Per-address window size for public-path traffic; None when 0."""
    name = "APO_PUBLIC_PATH_REQUESTS_PER_MINUTE"
    value = _parse_budget_int(name, os.environ.get(name), 120)
    return value if value > 0 else None


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
