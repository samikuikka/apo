# pyright: reportAny=false, reportImplicitOverride=false, reportMissingParameterType=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUntypedFunctionDecorator=false, reportUnusedCallResult=false, reportUnusedFunction=false, reportUnusedImport=false, reportAttributeAccessIssue=false

"""Request budget middleware: total request rate gets a global plus per-identity cap."""

from __future__ import annotations

import pytest
from collections.abc import Awaitable, Callable
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from apo.middleware.request_budget import (
    RequestBudgetLimits,
    RequestBudgetMiddleware,
    load_request_budget_limits,
)
from apo.services.telemetry_admission import TelemetryAdmissionController
from apo.services.telemetry_limits import (
    TelemetryAdmissionLimits,
    TokenBucketPolicy,
    load_telemetry_admission_limits,
)

_BUDGET_VARS = (
    "APO_REQUEST_BUDGET_IDENTITY_PER_MINUTE",
    "APO_REQUEST_BUDGET_IDENTITY_BURST",
    "APO_REQUEST_BUDGET_GLOBAL_PER_MINUTE",
    "APO_REQUEST_BUDGET_GLOBAL_BURST",
)


def _clear_budget_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in _BUDGET_VARS:
        monkeypatch.delenv(var, raising=False)


class _TestIdentityMiddleware(BaseHTTPMiddleware):
    """Map an X-Test-Identity header into cookie-style auth state.

    Added after the budget middleware so it runs outermost and the budget
    sees a populated request.state, mirroring AuthMiddleware's role.
    """

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        header = request.headers.get("X-Test-Identity")
        if header:
            request.state.user_id = header
            request.state.auth_method = "cookie"
        elif request.headers.get("X-Test-Auth-Method") == "anonymous":
            request.state.auth_method = "anonymous"
        return await call_next(request)


def _controller_limits(
    identity_policy: TokenBucketPolicy | None,
    global_policy: TokenBucketPolicy | None,
) -> TelemetryAdmissionLimits:
    """Controller limits mirroring the api.py wiring.

    A disabled dimension keeps a generous stand-in (api.py keeps the
    telemetry defaults there): the budget middleware never enforces it,
    and the generous value keeps it from binding in mixed configs.
    """
    filler = load_telemetry_admission_limits()
    return TelemetryAdmissionLimits(
        requests=identity_policy if identity_policy is not None else filler.requests,
        global_requests=(
            global_policy if global_policy is not None else filler.global_requests
        ),
        units=filler.units,
        global_units=filler.global_units,
        bytes=filler.bytes,
        global_bytes=filler.global_bytes,
        invalid_auth=filler.invalid_auth,
        max_concurrent_requests=filler.max_concurrent_requests,
        max_items_per_request=filler.max_items_per_request,
        max_tracked_identities=filler.max_tracked_identities,
        bucket_idle_seconds=filler.bucket_idle_seconds,
    )


def _budget_client(
    *,
    identity_policy: TokenBucketPolicy | None,
    global_policy: TokenBucketPolicy | None,
) -> TestClient:
    """A minimal app carrying the real budget middleware, fresh per test."""
    limits = RequestBudgetLimits(identity=identity_policy, global_requests=global_policy)
    controller = TelemetryAdmissionController(
        _controller_limits(identity_policy, global_policy)
    )

    mini = FastAPI()

    @mini.get("/v1/runs")
    def runs() -> dict[str, bool]:
        return {"ok": True}

    @mini.get("/health")
    def health() -> dict[str, bool]:
        return {"ok": True}

    @mini.get("/health/ready")
    def health_ready() -> dict[str, bool]:
        return {"ok": True}

    mini.add_middleware(
        RequestBudgetMiddleware, controller=controller, limits=limits
    )
    mini.add_middleware(_TestIdentityMiddleware)
    return TestClient(mini, raise_server_exceptions=False)


_GENEROUS = TokenBucketPolicy(tokens_per_minute=6000, burst=100)


# ---------------------------------------------------------------------------
# 1. Identity budget trips after its burst, isolating identities
# ---------------------------------------------------------------------------


def test_identity_budget_trips_and_isolates_identities() -> None:
    client = _budget_client(
        identity_policy=TokenBucketPolicy(tokens_per_minute=60, burst=3),
        global_policy=_GENEROUS,
    )
    statuses = [
        client.get("/v1/runs", headers={"X-Test-Identity": "user-a"}).status_code
        for _ in range(4)
    ]
    assert statuses == [200, 200, 200, 429]

    rejected = client.get("/v1/runs", headers={"X-Test-Identity": "user-a"})
    assert rejected.status_code == 429
    assert rejected.headers["X-RateLimit-Scope"] == "identity"
    assert rejected.headers["X-RateLimit-Limit"] == "3"

    # A different identity has its own bucket and still passes.
    assert (
        client.get("/v1/runs", headers={"X-Test-Identity": "user-b"}).status_code
        == 200
    )


# ---------------------------------------------------------------------------
# 2. Global budget trips across distinct identities
# ---------------------------------------------------------------------------


def test_global_budget_trips_across_distinct_identities() -> None:
    client = _budget_client(
        identity_policy=_GENEROUS,
        global_policy=TokenBucketPolicy(tokens_per_minute=60, burst=2),
    )
    # Three distinct callers, each under the generous identity ceiling:
    # the shared global burst of 2 admits two and rejects the third.
    assert (
        client.get("/v1/runs", headers={"X-Test-Identity": "user-a"}).status_code
        == 200
    )
    assert (
        client.get("/v1/runs", headers={"X-Test-Identity": "user-b"}).status_code
        == 200
    )
    rejected = client.get("/v1/runs", headers={"X-Test-Identity": "user-c"})
    assert rejected.status_code == 429
    assert rejected.headers["X-RateLimit-Scope"] == "global"


def test_disabled_identity_dimension_falls_back_to_global_only() -> None:
    # Authenticated callers exist, but the identity dimension is off: they
    # must be charged against the global bucket only, never a synthetic
    # per-identity budget.
    client = _budget_client(
        identity_policy=None,
        global_policy=TokenBucketPolicy(tokens_per_minute=60, burst=2),
    )
    statuses = [
        client.get("/v1/runs", headers={"X-Test-Identity": "user-a"}).status_code
        for _ in range(3)
    ]
    assert statuses == [200, 200, 429]
    rejected = client.get("/v1/runs", headers={"X-Test-Identity": "user-a"})
    assert rejected.headers["X-RateLimit-Scope"] == "global"


def test_disabled_global_dimension_keeps_no_residual_aggregate_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Identity on, global off. The controller still carries a filler global
    # policy (the telemetry default) from the wiring; the dispatch must
    # never charge it, or operators who disabled the aggregate would get a
    # hidden cap back. Shrink the filler to burst 5 so a residual charge
    # fails this test loudly instead of after 200 requests.
    monkeypatch.setenv("APO_TELEMETRY_GLOBAL_REQUEST_BURST", "5")
    client = _budget_client(
        identity_policy=TokenBucketPolicy(tokens_per_minute=60, burst=3),
        global_policy=None,
    )
    statuses = [
        client.get("/v1/runs", headers={"X-Test-Identity": f"user-{i}"}).status_code
        for i in range(20)
    ]
    assert statuses == [200] * 20


# ---------------------------------------------------------------------------
# 3. Unauthenticated requests count into the global bucket only
# ---------------------------------------------------------------------------


def test_unauthenticated_requests_never_touch_identity_dimension() -> None:
    # Identity burst of 1: if unauthenticated traffic were bucketed into a
    # synthetic identity, the second request would already be 429.
    client = _budget_client(
        identity_policy=TokenBucketPolicy(tokens_per_minute=60, burst=1),
        global_policy=_GENEROUS,
    )
    statuses = [client.get("/v1/runs").status_code for _ in range(5)]
    assert statuses == [200, 200, 200, 200, 200]


def test_unauthenticated_requests_trip_tiny_global_budget() -> None:
    client = _budget_client(
        identity_policy=_GENEROUS,
        global_policy=TokenBucketPolicy(tokens_per_minute=60, burst=2),
    )
    statuses = [client.get("/v1/runs").status_code for _ in range(3)]
    assert statuses == [200, 200, 429]
    rejected = client.get("/v1/runs")
    assert rejected.headers["X-RateLimit-Scope"] == "global"


def test_anonymous_demo_traffic_shares_one_open_dev_identity() -> None:
    # auth_method "anonymous" (anonymous-demo deployments) passes the gate
    # and derives the shared "open-dev" identity, so the demo is one tenant
    # with one identity bucket, exactly like the telemetry admission
    # middleware's treatment of the same traffic.
    client = _budget_client(
        identity_policy=TokenBucketPolicy(tokens_per_minute=60, burst=2),
        global_policy=_GENEROUS,
    )
    statuses = [
        client.get("/v1/runs", headers={"X-Test-Auth-Method": "anonymous"}).status_code
        for _ in range(3)
    ]
    assert statuses == [200, 200, 429]
    rejected = client.get("/v1/runs", headers={"X-Test-Auth-Method": "anonymous"})
    assert rejected.headers["X-RateLimit-Scope"] == "identity"

    # A cookie-authenticated caller is a different bucket entirely.
    assert (
        client.get("/v1/runs", headers={"X-Test-Identity": "user-a"}).status_code == 200
    )


# ---------------------------------------------------------------------------
# 4. Health probes and OPTIONS are exempt
# ---------------------------------------------------------------------------


def test_health_probes_and_options_exempt_from_exhausted_budget() -> None:
    client = _budget_client(
        identity_policy=_GENEROUS,
        global_policy=TokenBucketPolicy(tokens_per_minute=60, burst=2),
    )
    # Drain the global burst, then verify the exempt paths still answer.
    client.get("/v1/runs")
    client.get("/v1/runs")
    assert client.get("/v1/runs").status_code == 429

    assert client.get("/health").status_code == 200
    assert client.get("/health/ready").status_code == 200
    # OPTIONS is answered by route handling (405 here), never by the budget.
    assert client.options("/v1/runs").status_code != 429


# ---------------------------------------------------------------------------
# 5. Disabled dimensions
# ---------------------------------------------------------------------------


def test_load_limits_zero_disables_dimension(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_budget_env(monkeypatch)
    monkeypatch.setenv("APO_REQUEST_BUDGET_GLOBAL_PER_MINUTE", "0")
    limits = load_request_budget_limits()
    assert limits.global_requests is None
    assert limits.identity is not None
    assert limits.identity.tokens_per_minute == 3600
    assert limits.identity.burst == 600


def test_load_limits_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_budget_env(monkeypatch)
    limits = load_request_budget_limits()
    assert limits.identity == TokenBucketPolicy(tokens_per_minute=3600, burst=600)
    assert limits.global_requests == TokenBucketPolicy(
        tokens_per_minute=12_000, burst=2000
    )


def test_both_dimensions_disabled_passes_everything() -> None:
    client = _budget_client(identity_policy=None, global_policy=None)
    statuses = {client.get("/v1/runs").status_code for _ in range(10)}
    assert statuses == {200}


# ---------------------------------------------------------------------------
# 6. Invalid configuration fails fast, naming the variable
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad_value", ["", "abc", "-1", "3.5"])  # pyright: ignore[reportCallIssue]
def test_invalid_env_raises_value_error(
    monkeypatch: pytest.MonkeyPatch, bad_value: str
) -> None:
    _clear_budget_env(monkeypatch)
    monkeypatch.setenv("APO_REQUEST_BUDGET_GLOBAL_PER_MINUTE", bad_value)
    with pytest.raises(ValueError) as exc_info:
        load_request_budget_limits()
    assert "APO_REQUEST_BUDGET_GLOBAL_PER_MINUTE" in str(exc_info.value)


def test_invalid_burst_env_raises_value_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_budget_env(monkeypatch)
    monkeypatch.setenv("APO_REQUEST_BUDGET_IDENTITY_BURST", "nope")
    with pytest.raises(ValueError) as exc_info:
        load_request_budget_limits()
    assert "APO_REQUEST_BUDGET_IDENTITY_BURST" in str(exc_info.value)


# ---------------------------------------------------------------------------
# 7. Retry-After is a positive integer string
# ---------------------------------------------------------------------------


def test_retry_after_is_positive_integer_string() -> None:
    client = _budget_client(
        identity_policy=TokenBucketPolicy(tokens_per_minute=60, burst=1),
        global_policy=_GENEROUS,
    )
    client.get("/v1/runs", headers={"X-Test-Identity": "user-a"})
    rejected = client.get("/v1/runs", headers={"X-Test-Identity": "user-a"})
    assert rejected.status_code == 429
    retry_after = rejected.headers["Retry-After"]
    assert retry_after.isdigit()
    assert int(retry_after) >= 1
