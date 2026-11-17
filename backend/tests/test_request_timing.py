# pyright: reportAttributeAccessIssue=false, reportPrivateLocalImportUsage=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnusedCallResult=false, reportUnusedFunction=false

"""Request timing middleware: slow requests get named, streams do not."""

from __future__ import annotations

import asyncio
import logging

import pytest
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from apo.middleware.request_timing import (
    RequestTimingMiddleware,
    load_slow_request_threshold_ms,
)


class FakeClock:
    """Monotonic clock the test advances by hand: no real sleeping, no flakes."""

    def __init__(self) -> None:
        self.now: float = 0.0

    def __call__(self) -> float:
        return self.now


def _client(threshold_ms: float) -> tuple[TestClient, FakeClock]:
    clock = FakeClock()
    mini = FastAPI()

    @mini.get("/fast")
    async def fast() -> dict[str, bool]:
        return {"ok": True}

    @mini.get("/slow")
    async def slow() -> dict[str, bool]:
        clock.now += 0.05
        return {"ok": True}

    @mini.get("/stream")
    async def stream() -> StreamingResponse:
        async def chunks():
            for _ in range(3):
                # Body chunks arrive late; the response STARTED on time.
                clock.now += 0.05
                yield b"chunk"

        return StreamingResponse(chunks())

    mini.add_middleware(RequestTimingMiddleware, threshold_ms=threshold_ms, now=clock)
    return TestClient(mini, raise_server_exceptions=False), clock


def test_slow_request_logs_method_path_and_status(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client, _clock = _client(threshold_ms=30)
    with caplog.at_level(logging.WARNING, logger="apo.middleware.request_timing"):
        resp = client.get("/slow?token=secret-value")
    assert resp.status_code == 200
    warning = next(r for r in caplog.records if r.levelno == logging.WARNING)
    assert "GET" in warning.getMessage()
    assert "/slow" in warning.getMessage()
    assert "200" in warning.getMessage()
    assert "50 ms" in warning.getMessage()
    # The query string never reaches the timing log: invitation tokens
    # ride in it and the access-log redaction exists for exactly that.
    assert "secret-value" not in warning.getMessage()


def test_fast_request_stays_silent(caplog: pytest.LogCaptureFixture) -> None:
    client, _clock = _client(threshold_ms=30)
    with caplog.at_level(logging.WARNING, logger="apo.middleware.request_timing"):
        resp = client.get("/fast")
    assert resp.status_code == 200
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


def test_slow_body_with_fast_start_stays_silent(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # SSE and trace streams hold responses open for minutes by design;
    # only the time to response start counts.
    client, _clock = _client(threshold_ms=30)
    with caplog.at_level(logging.WARNING, logger="apo.middleware.request_timing"):
        resp = client.get("/stream")
    assert resp.status_code == 200
    assert b"chunk" in resp.content
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


def test_disabled_threshold_logs_nothing(caplog: pytest.LogCaptureFixture) -> None:
    client, _clock = _client(threshold_ms=0)
    with caplog.at_level(logging.WARNING, logger="apo.middleware.request_timing"):
        resp = client.get("/slow")
    assert resp.status_code == 200
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


def test_failed_request_after_threshold_is_named(
    caplog: pytest.LogCaptureFixture,
) -> None:
    clock = FakeClock()
    mini = FastAPI()

    @mini.get("/dies")
    async def dies() -> dict[str, bool]:
        clock.now += 0.05
        raise RuntimeError("boom")

    mini.add_middleware(RequestTimingMiddleware, threshold_ms=30, now=clock)
    client = TestClient(mini, raise_server_exceptions=False)
    with caplog.at_level(logging.WARNING, logger="apo.middleware.request_timing"):
        resp = client.get("/dies")
    assert resp.status_code == 500
    warning = next(
        r
        for r in caplog.records
        if r.levelno == logging.WARNING and "/dies" in r.getMessage()
    )
    assert "without responding" in warning.getMessage()


def test_threshold_loader_rejects_garbage_and_negatives(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APO_SLOW_REQUEST_MS", "soon")
    with pytest.raises(ValueError, match="APO_SLOW_REQUEST_MS"):
        load_slow_request_threshold_ms()
    monkeypatch.setenv("APO_SLOW_REQUEST_MS", "-5")
    with pytest.raises(ValueError, match="APO_SLOW_REQUEST_MS"):
        load_slow_request_threshold_ms()


def test_threshold_loader_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("APO_SLOW_REQUEST_MS", raising=False)
    assert load_slow_request_threshold_ms() == 1000.0
    monkeypatch.setenv("APO_SLOW_REQUEST_MS", "0")
    assert load_slow_request_threshold_ms() == 0.0


def test_real_sleep_route_is_reported(caplog: pytest.LogCaptureFixture) -> None:
    # One end-to-end check against the real clock: a route that awaits
    # 120 ms crosses the 30 ms threshold the same way the fake clock says.
    mini = FastAPI()

    @mini.get("/realslow")
    async def realslow() -> dict[str, bool]:
        await asyncio.sleep(0.12)
        return {"ok": True}

    mini.add_middleware(RequestTimingMiddleware, threshold_ms=30)
    client = TestClient(mini)
    with caplog.at_level(logging.WARNING, logger="apo.middleware.request_timing"):
        assert client.get("/realslow").status_code == 200
    assert any("realslow" in r.getMessage() for r in caplog.records)
