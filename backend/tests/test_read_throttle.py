# pyright: reportAttributeAccessIssue=false, reportPrivateLocalImportUsage=false, reportUnknownMemberType=false, reportUnknownParameterType=false

"""Read-throttle middleware — heavy list reads get a generous per-identity cap."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from apo.middleware.read_throttle import ReadThrottle, ReadThrottleMiddleware


def _throttled_client(max_requests: int) -> TestClient:
    """A minimal app carrying the real middleware on the real route shapes.

    Built fresh per test: adding middleware to the shared `apo.api.app`
    would leak the throttle into every other test in the process.
    """
    mini = FastAPI()

    @mini.get("/v1/runs")
    def list_runs() -> dict[str, bool]:
        return {"ok": True}

    @mini.get("/v1/runs/{run_id}")
    def get_run(run_id: str) -> dict[str, bool]:
        return {"ok": True}

    @mini.patch("/v1/runs/{run_id}")
    def patch_run(run_id: str) -> dict[str, bool]:
        return {"ok": True}

    @mini.post("/v1/runs/{run_id}/reproject")
    def reproject_run(run_id: str) -> dict[str, bool]:
        return {"ok": True}

    @mini.get("/v1/runs/{run_id}/calls/{call_id}")
    def get_call(run_id: str, call_id: str) -> dict[str, bool]:
        return {"ok": True}

    @mini.get("/v1/runs/{run_id}/adjacent")
    def adjacent_runs(run_id: str) -> dict[str, bool]:
        return {"ok": True}

    mini.add_middleware(
        ReadThrottleMiddleware,
        throttle=ReadThrottle(max_requests=max_requests, window_seconds=60),
    )
    return TestClient(mini, raise_server_exceptions=False)


def test_throttle_429s_after_limit_on_protected_read() -> None:
    client = _throttled_client(max_requests=3)
    statuses = [client.get("/v1/runs").status_code for _ in range(5)]
    assert statuses[:3] == [200, 200, 200]
    assert statuses[3] == 429
    assert statuses[4] == 429


def test_throttle_reports_retry_after() -> None:
    client = _throttled_client(max_requests=1)
    client.get("/v1/runs")
    resp = client.get("/v1/runs")
    assert resp.status_code == 429
    assert resp.headers["Retry-After"] == "60"
    assert resp.headers["X-RateLimit-Limit"] == "1"


def test_throttle_covers_run_detail() -> None:
    # Run detail loads every call of the run with its payloads, so it is as
    # heavy as a list read and shares the per-identity window.
    client = _throttled_client(max_requests=2)
    statuses = [client.get("/v1/runs/run-1").status_code for _ in range(3)]
    assert statuses == [200, 200, 429]


def test_throttle_covers_reproject() -> None:
    # Reproject rewrites a run's projection while holding the write lock, so
    # a loop of them stalls every tenant's writes.
    client = _throttled_client(max_requests=2)
    statuses = [
        client.post("/v1/runs/run-1/reproject").status_code for _ in range(3)
    ]
    assert statuses == [200, 200, 429]


def test_heavy_run_routes_share_one_window_with_the_list() -> None:
    # One identity, one window across every protected route: detail and
    # reproject are not a second budget beside the list.
    client = _throttled_client(max_requests=3)
    assert client.get("/v1/runs").status_code == 200
    assert client.get("/v1/runs/run-1").status_code == 200
    assert client.post("/v1/runs/run-1/reproject").status_code == 200

    assert client.get("/v1/runs/run-1").status_code == 429
    assert client.post("/v1/runs/run-1/reproject").status_code == 429
    assert client.get("/v1/runs").status_code == 429


def test_throttle_leaves_cheap_run_subresources_and_writes_alone() -> None:
    client = _throttled_client(max_requests=1)
    client.get("/v1/runs")
    assert client.get("/v1/runs/run-1").status_code == 429
    # A single call row and the neighbor lookup are indexed one-row reads.
    # PATCH shares the detail path but is the task client's own progress
    # write (about 2 per second per run); throttling it would fail runs.
    for _ in range(3):
        assert client.get("/v1/runs/run-1/calls/call-1").status_code == 200
        assert client.get("/v1/runs/run-1/adjacent").status_code == 200
        assert client.patch("/v1/runs/run-1").status_code == 200


def test_throttle_disabled_when_max_zero() -> None:
    client = _throttled_client(max_requests=0)
    statuses = {client.get("/v1/runs").status_code for _ in range(10)}
    assert statuses == {200}


def test_throttle_scopes_identities_separately() -> None:
    # The unauthenticated test client shares one identity (client address);
    # per-identity scoping is verified at the limiter level.
    throttle = ReadThrottle(max_requests=1, window_seconds=60)
    assert throttle.is_allowed("user_id:a")
    assert not throttle.is_allowed("user_id:a")
    assert throttle.is_allowed("user_id:b")


def _blind_spot_client(max_requests: int) -> TestClient:
    """The real middleware over the Wave-2 blind-spot route shapes.

    Mirrors `_throttled_client` for the routes G5 (issue #230) added:
    sessions, distinct-*, bulk-export (POST), and batch-run detail.
    """
    mini = FastAPI()

    @mini.get("/v1/runs/sessions")
    def sessions() -> dict[str, bool]:
        return {"ok": True}

    @mini.get("/v1/runs/distinct-models")
    def distinct_models() -> dict[str, bool]:
        return {"ok": True}

    @mini.post("/v1/runs/bulk-export")
    def bulk_export() -> dict[str, bool]:
        return {"ok": True}

    @mini.get("/v1/agent-task-batch-runs/{batch_run_id}")
    def batch_detail(batch_run_id: str) -> dict[str, bool]:
        return {"ok": True}

    mini.add_middleware(
        ReadThrottleMiddleware,
        throttle=ReadThrottle(max_requests=max_requests, window_seconds=60),
    )
    return TestClient(mini, raise_server_exceptions=False)


def test_throttle_covers_the_g5_blind_spots() -> None:
    """Each newly protected path trips the same per-identity cap."""
    heavy_calls = [
        ("get", "/v1/runs/sessions"),
        ("get", "/v1/runs/distinct-models"),
        ("post", "/v1/runs/bulk-export"),
        ("get", "/v1/agent-task-batch-runs/b-1"),
    ]
    for method, path in heavy_calls:
        # Fresh client per path: one identity's window is shared across all
        # protected routes, so earlier paths would starve later ones.
        client = _blind_spot_client(max_requests=2)
        call = getattr(client, method)
        statuses = [call(path).status_code for _ in range(3)]
        assert statuses == [200, 200, 429], f"{method.upper()} {path}: {statuses}"



def test_anonymous_identity_keys_by_resolved_client_ip() -> None:
    # Behind the ingress the socket peer is the proxy; keying anonymous
    # visitors by it puts every demo poller into one shared window.
    from apo.middleware.read_throttle import _identity_for
    from starlette.requests import Request as StarletteRequest

    def _request(headers: dict[str, str], peer: str) -> StarletteRequest:
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/v1/runs",
            "headers": [
                (key.lower().encode(), value.encode())
                for key, value in headers.items()
            ],
            "client": (peer, 51234),
            "query_string": b"",
        }
        return StarletteRequest(scope)

    # 10.0.0.9 is inside the default trusted-proxy ranges, so the forwarded
    # first hop decides the identity.
    proxy = _request({"x-forwarded-for": "203.0.113.7"}, "10.0.0.9")
    assert _identity_for(proxy) == "ip:203.0.113.7"
    other = _request({"x-forwarded-for": "198.51.100.2"}, "10.0.0.9")
    assert _identity_for(other) == "ip:198.51.100.2"

    # An untrusted peer is keyed by itself; a spoofed header changes nothing.
    direct = _request({"x-forwarded-for": "203.0.113.7"}, "203.0.113.99")
    assert _identity_for(direct) == "ip:203.0.113.99"


def test_retry_after_shrinks_with_the_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import apo.middleware.read_throttle as read_throttle_module

    now = [1000.0]
    monkeypatch.setattr(read_throttle_module.time, "monotonic", lambda: now[0])

    throttle = ReadThrottle(max_requests=1, window_seconds=60)
    assert throttle.is_allowed("ip:1.1.1.1")
    assert throttle.retry_after("ip:1.1.1.1") == 60

    now[0] += 59.2
    assert throttle.retry_after("ip:1.1.1.1") == 1
