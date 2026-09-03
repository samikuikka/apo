"""Read-throttle middleware — heavy list reads get a generous per-identity cap."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from apo.middleware.read_throttle import ReadThrottle, ReadThrottleMiddleware


def _throttled_client(max_requests: int) -> TestClient:
    """A minimal app carrying the real middleware on the real route shapes.

    Built fresh per test — adding middleware to the shared `apo.api.app`
    would leak the throttle into every other test in the process.
    """
    mini = FastAPI()

    @mini.get("/v1/runs")
    def list_runs() -> dict[str, bool]:
        return {"ok": True}

    @mini.get("/v1/runs/{run_id}")
    def get_run(run_id: str) -> dict[str, bool]:
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


def test_throttle_leaves_detail_reads_alone() -> None:
    client = _throttled_client(max_requests=1)
    client.get("/v1/runs")
    assert client.get("/v1/runs").status_code == 429
    # Detail reads (by id) are not on the protected list and never trip it.
    for _ in range(3):
        assert client.get("/v1/runs/some-trace-id").status_code == 200


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
