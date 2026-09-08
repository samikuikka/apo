# pyright: reportAny=false, reportImplicitOverride=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUntypedFunctionDecorator=false, reportUnusedCallResult=false, reportUnusedImport=false
# pyright: reportAttributeAccessIssue=false, reportCallIssue=false

"""Request-body limits for write paths.

Two layers, mirroring the telemetry-transport tests:

1. Loader — env parsing/validation for the three knobs.
2. Middleware — streamed byte-cap enforcement on every capped write path,
   driven through a hand-built ASGI scope (declared Content-Length AND
   chunked-body overrun), plus the full-app wiring scene test proving the
   413 fires before auth.
"""

from __future__ import annotations

import asyncio

import pytest
from starlette.requests import Request
from starlette.responses import PlainTextResponse

from apo.middleware.request_size import RequestSizeMiddleware
from apo.services.request_body_limits import (
    RequestBodyLimitError,
    RequestBodyLimits,
    load_request_body_limits,
)

_TINY_LIMITS = RequestBodyLimits(
    result_max_bytes=16,
    artifact_upload_max_bytes=16,
    write_max_bytes=16,
    result_evidence_max_bytes=16,
)

# Every write path the middleware table must cap (method, path).
_CAPPED_WRITE_PATHS = [
    ("POST", "/v1/agent-task-runs/tr-1/result"),
    ("PUT", "/v1/agent-task-artifact-uploads/au-1"),
    ("POST", "/v1/executor-protocol/v1/attempts/att-1/result"),
    ("POST", "/v1/executor-protocol/v1/attempts/att-1/failure"),
    ("POST", "/v1/executor-protocol/v2/attempts/att-1/result"),
    ("POST", "/v1/executor-protocol/v2/attempts/att-1/failure"),
    ("POST", "/v1/executor-protocol/v1/attempts/att-1/result-evidence"),
    ("POST", "/v1/executor-protocol/v2/attempts/att-1/result-evidence"),
    ("PUT", "/v1/executor-protocol/result-evidence/rev-1"),
    ("POST", "/v1/agent-task-runs/tr-1/judgments"),
    ("POST", "/api/v1/comments"),
    ("POST", "/api/v1/comments/cm-1/reactions"),
    ("POST", "/v1/runs"),
    ("POST", "/v1/runs/r-1/custom-metrics"),
    ("POST", "/v1/runs/bulk-export"),
]

# Paths that must NOT be capped (no matching rule, or wrong method).
_UNCAPPED_PATHS = [
    ("GET", "/v1/agent-task-runs"),
    ("GET", "/v1/runs"),
    ("POST", "/v1/agent-task-runs/tr-1/cancel"),
    ("POST", "/v1/agent-task-runs/tr-1/test-result-corrections"),
    ("PUT", "/v1/executor-protocol/v1/attempts/att-1/result"),
]


async def _body_echo_app(scope, receive, send):
    """Downstream app: read the body, echo its length."""
    request = Request(scope, receive)
    body = await request.body()
    response = PlainTextResponse(f"ok:{len(body)}")
    await response(scope, receive, send)


def _drive(
    middleware: RequestSizeMiddleware,
    method: str,
    path: str,
    body_chunks: list[bytes],
    *,
    content_length: int | None = None,
) -> tuple[int, bytes, int]:
    """Drive the middleware directly. Returns (status, body, receive_calls)."""
    headers = [(b"content-type", b"application/json")]
    if content_length is not None:
        headers.append((b"content-length", str(content_length).encode()))

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": headers,
        "client": ("127.0.0.1", 12345),
        "server": ("127.0.0.1", 8000),
    }

    chunk_iter = iter(body_chunks)
    receive_count = 0

    async def receive():
        nonlocal receive_count
        receive_count += 1
        try:
            chunk = next(chunk_iter)
            return {"type": "http.request", "body": chunk, "more_body": True}
        except StopIteration:
            return {"type": "http.request", "body": b"", "more_body": False}

    sent: list[dict] = []  # pyright: ignore[reportMissingTypeArgument]

    async def send(message):
        sent.append(message)

    asyncio.run(middleware(scope, receive, send))

    status = 0
    body = b""
    for msg in sent:
        if msg["type"] == "http.response.start":
            status = msg["status"]
        elif msg["type"] == "http.response.body":
            body += msg.get("body", b"")
    return status, body, receive_count


def _middleware(limits: RequestBodyLimits | None = None) -> RequestSizeMiddleware:
    return RequestSizeMiddleware(_body_echo_app, body_limits=limits)


# ---------------------------------------------------------------------------
# 1. Loader
# ---------------------------------------------------------------------------


class TestLoadRequestBodyLimits:
    def test_defaults_when_unset(self, monkeypatch: pytest.MonkeyPatch):
        for name in (
            "APO_RESULT_MAX_BODY_BYTES",
            "APO_ARTIFACT_UPLOAD_MAX_BODY_BYTES",
            "APO_WRITE_MAX_BODY_BYTES",
        ):
            monkeypatch.delenv(name, raising=False)
        limits = load_request_body_limits()
        assert limits.result_max_bytes == 10_485_760
        assert limits.artifact_upload_max_bytes == 104_857_600
        assert limits.write_max_bytes == 10_485_760
        assert limits.result_evidence_max_bytes == 104_857_600

    def test_env_overrides(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("APO_RESULT_MAX_BODY_BYTES", "2048")
        monkeypatch.setenv("APO_ARTIFACT_UPLOAD_MAX_BODY_BYTES", "4096")
        monkeypatch.setenv("APO_WRITE_MAX_BODY_BYTES", "8192")
        monkeypatch.setenv("APO_RESULT_EVIDENCE_MAX_BODY_BYTES", "16384")
        limits = load_request_body_limits()
        assert limits == RequestBodyLimits(2048, 4096, 8192, 16384)

    @pytest.mark.parametrize("raw", ["", "0", "-5", "abc", "1.5"])
    def test_invalid_values_fail_naming_the_variable(
        self, monkeypatch: pytest.MonkeyPatch, raw: str
    ):
        monkeypatch.setenv("APO_WRITE_MAX_BODY_BYTES", raw)
        with pytest.raises(RequestBodyLimitError, match="APO_WRITE_MAX_BODY_BYTES"):
            load_request_body_limits()


# ---------------------------------------------------------------------------
# 2. Middleware enforcement
# ---------------------------------------------------------------------------


class TestWritePathByteCaps:
    @pytest.mark.parametrize(("method", "path"), _CAPPED_WRITE_PATHS)
    def test_declared_content_length_over_cap_returns_413(self, method, path):
        status, _, _ = _drive(
            _middleware(_TINY_LIMITS),
            method,
            path,
            [b"x" * 32],
            content_length=32,
        )
        assert status == 413

    @pytest.mark.parametrize(("method", "path"), _CAPPED_WRITE_PATHS)
    def test_chunked_body_crossing_cap_returns_413(self, method, path):
        # Declared length lies small; the streamed counter must still reject.
        status, _, receive_calls = _drive(
            _middleware(_TINY_LIMITS),
            method,
            path,
            [b"x" * 10, b"x" * 10],
            content_length=8,
        )
        assert status == 413
        # Reading stops once the cap is crossed — no full-body buffering.
        assert receive_calls == 2

    @pytest.mark.parametrize(("method", "path"), _CAPPED_WRITE_PATHS)
    def test_body_under_cap_passes_through(self, method, path):
        status, body, _ = _drive(
            _middleware(_TINY_LIMITS),
            method,
            path,
            [b"xyz"],
            content_length=3,
        )
        assert status == 200
        assert body == b"ok:3"

    @pytest.mark.parametrize(("method", "path"), _UNCAPPED_PATHS)
    def test_uncapped_paths_pass_through(self, method, path):
        status, body, _ = _drive(
            _middleware(_TINY_LIMITS),
            method,
            path,
            [b"x" * 64],
            content_length=64,
        )
        assert status == 200
        assert body == b"ok:64"

    def test_default_construction_keeps_shipped_limits(self):
        # No body_limits → the historical hardcoded caps (10 MiB / 100 MiB),
        # so direct constructions keep their byte-for-byte behavior.
        resolved = {
            (m, p, s): v
            for m, p, s, v in _middleware()._limited_paths  # pyright: ignore[reportPrivateUsage]
        }
        assert resolved[("POST", "/v1/agent-task-runs/", "result")] == 10_485_760
        assert resolved[("PUT", "/v1/agent-task-artifact-uploads/", None)] == 104_857_600
        assert resolved[("POST", "/v1/runs", None)] == 10_485_760


# ---------------------------------------------------------------------------
# 3. Full-app wiring (scene)
# ---------------------------------------------------------------------------


class TestAppWiring:
    def test_post_runs_413_before_auth(self, client):
        # RequestSize sits OUTSIDE Auth: an oversized body is rejected with
        # 413 without any credential (default write cap: 10 MiB).
        resp = client.post(
            "/v1/runs",
            content=b"x" * (10 * 1024 * 1024 + 1),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 413
        assert "exceeds" in resp.json()["detail"]
