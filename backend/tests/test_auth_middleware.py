# pyright: reportAny=false
"""Authentication middleware ordering guarantees."""

from collections.abc import Awaitable, Callable

import pytest
from starlette.requests import Request
from starlette.responses import Response

from apo.auth import middleware


@pytest.mark.anyio
async def test_api_key_usage_write_happens_after_route(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """API-key bookkeeping must not contend with the protected route's write."""
    events: list[str] = []

    monkeypatch.setattr(middleware, "_is_open_dev_bypass_allowed", lambda: False)
    monkeypatch.setattr(
        middleware,
        "_authenticate",
        lambda _request: {
            "auth_method": "api_key",
            "api_key_id": "key-1",
        },
    )
    monkeypatch.setattr(
        middleware.api_key_usage_tracker,
        "record_use",
        lambda _key_id, _engine: events.append("usage"),
    )

    async def call_next(_request: Request) -> Response:
        events.append("route")
        return Response("ok")

    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/v1/agent-task-batch-runs/caller",
            "raw_path": b"/v1/agent-task-batch-runs/caller",
            "query_string": b"",
            "headers": [],
            "scheme": "http",
            "server": ("testserver", 80),
            "client": ("127.0.0.1", 1234),
        }
    )

    await middleware.AuthMiddleware(object()).dispatch(request, call_next)

    assert events == ["route", "usage"]
