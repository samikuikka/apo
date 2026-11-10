# pyright: reportAny=false, reportImplicitOverride=false, reportMissingParameterType=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUntypedFunctionDecorator=false, reportUnusedCallResult=false, reportUnusedFunction=false, reportUnusedImport=false, reportAttributeAccessIssue=false

"""Request budget middleware: global plus per-identity caps, per-address on public paths."""

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
    "APO_PUBLIC_PATH_REQUESTS_PER_MINUTE",
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


def _budget_app(
    *,
    identity_policy: TokenBucketPolicy | None,
    global_policy: TokenBucketPolicy | None,
    public_path_per_ip: int | None = None,
) -> FastAPI:
    """A minimal app carrying the real budget middleware, fresh per test.

    ``/api/public/health`` and ``/auth/has-users`` are real public paths
    (the auth allow-list admits them); ``/v1/runs`` is a protected one.
    """
    limits = RequestBudgetLimits(
        identity=identity_policy,
        global_requests=global_policy,
        public_path_per_ip=public_path_per_ip,
    )
    controller = TelemetryAdmissionController(
        _controller_limits(identity_policy, global_policy)
    )

    mini = FastAPI()

    @mini.get("/v1/runs")
    def runs() -> dict[str, bool]:
        return {"ok": True}

    @mini.get("/api/public/health")
    def public_health() -> dict[str, bool]:
        return {"ok": True}

    @mini.get("/auth/has-users")
    def has_users() -> dict[str, bool]:
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
    return mini


def _budget_client(
    *,
    identity_policy: TokenBucketPolicy | None,
    global_policy: TokenBucketPolicy | None,
    public_path_per_ip: int | None = None,
    client: tuple[str, int] = ("testclient", 50000),
) -> TestClient:
    """One caller of a fresh budget app.

    ``client`` is the socket peer. The default is not an IP address, so it
    is never a trusted proxy: its requests are attributable to it.
    """
    app = _budget_app(
        identity_policy=identity_policy,
        global_policy=global_policy,
        public_path_per_ip=public_path_per_ip,
    )
    return TestClient(app, raise_server_exceptions=False, client=client)


_GENEROUS = TokenBucketPolicy(tokens_per_minute=6000, burst=100)
_PUBLIC = "/api/public/health"


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
# 3. Identity-less requests on protected paths (the open-dev bypass) count
#    into the global bucket only
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


# ---------------------------------------------------------------------------
# 8. Public paths: one window per client address, nothing shared is charged
# ---------------------------------------------------------------------------


def test_public_path_flood_is_capped_per_address_and_spares_the_global_bucket() -> None:
    # Global burst of 2: if the flood drew from the shared bucket, the third
    # public request would already be a global 429.
    client = _budget_client(
        identity_policy=_GENEROUS,
        global_policy=TokenBucketPolicy(tokens_per_minute=60, burst=2),
        public_path_per_ip=3,
    )
    statuses = [client.get(_PUBLIC).status_code for _ in range(5)]
    assert statuses == [200, 200, 200, 429, 429]

    rejected = client.get(_PUBLIC)
    assert rejected.status_code == 429
    assert rejected.json() == {
        "detail": "Public path request rate limit exceeded for this address."
    }
    assert rejected.headers["X-RateLimit-Scope"] == "ip"
    assert rejected.headers["X-RateLimit-Resource"] == "public-requests"
    assert rejected.headers["X-RateLimit-Limit"] == "3"
    assert rejected.headers["X-RateLimit-Remaining"] == "0"
    retry_after = rejected.headers["Retry-After"]
    assert retry_after.isdigit()
    assert 1 <= int(retry_after) <= 61

    # The shared bucket still holds its whole burst: exactly two
    # global-charged requests pass and the third is the first global 429.
    after = [client.get("/v1/runs").status_code for _ in range(3)]
    assert after == [200, 200, 429]
    assert client.get("/v1/runs").headers["X-RateLimit-Scope"] == "global"


def test_public_path_flood_leaves_authenticated_callers_untouched() -> None:
    client = _budget_client(
        identity_policy=TokenBucketPolicy(tokens_per_minute=60, burst=2),
        global_policy=TokenBucketPolicy(tokens_per_minute=60, burst=2),
        public_path_per_ip=1,
    )
    for _ in range(20):
        client.get(_PUBLIC)
    assert client.get(_PUBLIC).status_code == 429

    # Twenty-one public requests later an authenticated caller still has its
    # full identity burst and the full global burst behind it.
    statuses = [
        client.get("/v1/runs", headers={"X-Test-Identity": "user-a"}).status_code
        for _ in range(2)
    ]
    assert statuses == [200, 200]


def test_public_path_window_is_per_address() -> None:
    app = _budget_app(
        identity_policy=_GENEROUS, global_policy=_GENEROUS, public_path_per_ip=2
    )
    first = TestClient(app, client=("203.0.113.10", 40000))
    second = TestClient(app, client=("203.0.113.11", 40000))

    assert [first.get(_PUBLIC).status_code for _ in range(3)] == [200, 200, 429]
    # Another address has its own window; the first one's flood cost it nothing.
    assert [second.get(_PUBLIC).status_code for _ in range(3)] == [200, 200, 429]


def test_public_path_window_keys_by_the_client_a_trusted_proxy_forwarded() -> None:
    # Behind the ingress every request shares the proxy's socket address, so
    # the window must key by the client address the proxy forwarded.
    app = _budget_app(
        identity_policy=_GENEROUS, global_policy=_GENEROUS, public_path_per_ip=1
    )
    proxy = TestClient(app, client=("172.18.0.5", 40000))
    alice = {"X-Forwarded-For": "198.51.100.1"}
    bob = {"X-Forwarded-For": "198.51.100.2"}

    assert proxy.get(_PUBLIC, headers=alice).status_code == 200
    assert proxy.get(_PUBLIC, headers=alice).status_code == 429
    assert proxy.get(_PUBLIC, headers=bob).status_code == 200


def test_public_path_window_spans_every_public_path() -> None:
    # One address, one window: rotating endpoints must not reset it.
    client = _budget_client(
        identity_policy=_GENEROUS, global_policy=_GENEROUS, public_path_per_ip=2
    )
    assert client.get("/api/public/health").status_code == 200
    assert client.get("/auth/has-users").status_code == 200
    assert client.get("/api/public/health").status_code == 429
    assert client.get("/auth/has-users").status_code == 429


def test_installation_own_public_calls_keep_the_global_charge() -> None:
    # The dashboard server's own fetches come from a trusted peer with no
    # forwarded client address. Keyed by that peer, every visitor would share
    # one window and a visitor wave would fail everyone's sign-in. They skip
    # the window and charge the global bucket exactly as before.
    client = _budget_client(
        identity_policy=_GENEROUS,
        global_policy=TokenBucketPolicy(tokens_per_minute=60, burst=5),
        public_path_per_ip=2,
        client=("172.18.0.5", 40000),
    )
    statuses = [client.get(_PUBLIC).status_code for _ in range(6)]
    # Past the window of 2 with no per-address 429; the global burst binds.
    assert statuses == [200, 200, 200, 200, 200, 429]
    assert client.get(_PUBLIC).headers["X-RateLimit-Scope"] == "global"


def test_open_dev_requests_on_protected_paths_never_meet_the_public_window() -> None:
    # Identity-less traffic on a NON-public path is the development open-dev
    # bypass, not public-path traffic: a window of 1 must not bind it.
    client = _budget_client(
        identity_policy=_GENEROUS, global_policy=_GENEROUS, public_path_per_ip=1
    )
    assert {client.get("/v1/runs").status_code for _ in range(5)} == {200}


def test_disabled_public_window_restores_the_global_charge() -> None:
    client = _budget_client(
        identity_policy=_GENEROUS,
        global_policy=TokenBucketPolicy(tokens_per_minute=60, burst=2),
        public_path_per_ip=None,
    )
    assert [client.get(_PUBLIC).status_code for _ in range(3)] == [200, 200, 429]
    assert client.get(_PUBLIC).headers["X-RateLimit-Scope"] == "global"


def test_public_window_alone_is_enforced_with_both_buckets_off() -> None:
    client = _budget_client(
        identity_policy=None, global_policy=None, public_path_per_ip=2
    )
    assert [client.get(_PUBLIC).status_code for _ in range(3)] == [200, 200, 429]
    # Nothing else is metered when both token dimensions are disabled.
    assert {client.get("/v1/runs").status_code for _ in range(10)} == {200}


def test_health_probes_and_options_stay_exempt_from_an_exhausted_public_window() -> None:
    client = _budget_client(
        identity_policy=_GENEROUS, global_policy=_GENEROUS, public_path_per_ip=1
    )
    assert client.get(_PUBLIC).status_code == 200
    assert client.get(_PUBLIC).status_code == 429

    # A 429 on the compose healthcheck would restart-loop the container.
    assert client.get("/health").status_code == 200
    assert client.get("/health/ready").status_code == 200
    assert client.options(_PUBLIC).status_code != 429


# ---------------------------------------------------------------------------
# 9. The public window's variable: default, disable, fail-fast validation
# ---------------------------------------------------------------------------


def test_load_limits_public_window_default(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_budget_env(monkeypatch)
    assert load_request_budget_limits().public_path_per_ip == 120


def test_load_limits_zero_disables_public_window_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_budget_env(monkeypatch)
    monkeypatch.setenv("APO_PUBLIC_PATH_REQUESTS_PER_MINUTE", "0")
    limits = load_request_budget_limits()
    assert limits.public_path_per_ip is None
    assert limits.identity is not None
    assert limits.global_requests is not None


@pytest.mark.parametrize("bad_value", ["", "abc", "-1", "3.5"])  # pyright: ignore[reportCallIssue]
def test_invalid_public_window_env_raises_value_error(
    monkeypatch: pytest.MonkeyPatch, bad_value: str
) -> None:
    _clear_budget_env(monkeypatch)
    monkeypatch.setenv("APO_PUBLIC_PATH_REQUESTS_PER_MINUTE", bad_value)
    with pytest.raises(ValueError) as exc_info:
        load_request_budget_limits()
    assert "APO_PUBLIC_PATH_REQUESTS_PER_MINUTE" in str(exc_info.value)


# ---------------------------------------------------------------------------
# 10. Through the app factory: the window is wired into the shipped stack
# ---------------------------------------------------------------------------


def test_shipped_app_caps_a_health_probe_flood_per_address(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_budget_env(monkeypatch)
    monkeypatch.setenv("APO_PUBLIC_PATH_REQUESTS_PER_MINUTE", "3")
    from apo.api import create_app

    client = TestClient(create_app(), raise_server_exceptions=False)
    statuses = [client.get("/api/public/health").status_code for _ in range(5)]
    assert 429 not in statuses[:3]
    assert statuses[3:] == [429, 429]
    assert client.get("/api/public/health").headers["X-RateLimit-Scope"] == "ip"
    # The compose healthcheck path answers no matter how hard the flood is.
    assert client.get("/health").status_code != 429


def test_shipped_app_wires_the_window_even_with_both_buckets_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_budget_env(monkeypatch)
    monkeypatch.setenv("APO_REQUEST_BUDGET_IDENTITY_PER_MINUTE", "0")
    monkeypatch.setenv("APO_REQUEST_BUDGET_GLOBAL_PER_MINUTE", "0")
    monkeypatch.setenv("APO_PUBLIC_PATH_REQUESTS_PER_MINUTE", "2")
    from apo.api import create_app

    client = TestClient(create_app(), raise_server_exceptions=False)
    statuses = [client.get("/api/public/health").status_code for _ in range(3)]
    assert 429 not in statuses[:2]
    assert statuses[2] == 429
