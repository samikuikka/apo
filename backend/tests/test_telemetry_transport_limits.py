# pyright: reportAny=false, reportImplicitOverride=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUntypedFunctionDecorator=false, reportUnusedCallResult=false, reportUnusedImport=false
# pyright: reportAttributeAccessIssue=false

"""Acceptance tests: bounded public OTLP request work.

Red-first: these tests are written before the implementation. Each test
maps to an acceptance test in the spec.
"""

from __future__ import annotations

import asyncio
import gzip
import io
import json
import time

import pytest
from fastapi.testclient import TestClient
from apo.models.db import OtlpSpanDB
from sqlmodel import Session, select


# ---------------------------------------------------------------------------
# Unit tests 1-2: TelemetryTransportLimits configuration
# ---------------------------------------------------------------------------

_BACKEND_LIMIT_VARS = (
    "APO_TELEMETRY_MAX_REQUEST_BYTES",
    "APO_OTLP_MAX_DECOMPRESSED_BYTES",
    "APO_OTLP_MAX_SPANS_PER_REQUEST",
    "APO_TELEMETRY_BODY_TIMEOUT_SECONDS",
)


def _clear_limit_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove every transport-limit env var so defaults apply."""
    for var in _BACKEND_LIMIT_VARS:
        monkeypatch.delenv(var, raising=False)


class TestTransportLimitDefaults:
    """Acceptance test 1: all admission defaults are exact."""

    def test_defaults_match_the_spec_table(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from apo.services.telemetry_limits import load_telemetry_transport_limits

        _clear_limit_env(monkeypatch)
        limits = load_telemetry_transport_limits()

        assert limits.max_request_bytes == 10_485_760
        assert limits.max_otlp_decompressed_bytes == 10_485_760
        assert limits.max_otlp_spans_per_request == 2048
        assert limits.body_timeout_seconds == 30

    def test_overrides_are_honored(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from apo.services.telemetry_limits import load_telemetry_transport_limits

        _clear_limit_env(monkeypatch)
        monkeypatch.setenv("APO_TELEMETRY_MAX_REQUEST_BYTES", "999")
        monkeypatch.setenv("APO_OTLP_MAX_DECOMPRESSED_BYTES", "888")
        monkeypatch.setenv("APO_OTLP_MAX_SPANS_PER_REQUEST", "77")
        monkeypatch.setenv("APO_TELEMETRY_BODY_TIMEOUT_SECONDS", "5")

        limits = load_telemetry_transport_limits()
        assert limits.max_request_bytes == 999
        assert limits.max_otlp_decompressed_bytes == 888
        assert limits.max_otlp_spans_per_request == 77
        assert limits.body_timeout_seconds == 5


class TestTransportLimitValidation:
    """Acceptance test 2: invalid limits fail startup, naming the bad variable."""

    @pytest.mark.parametrize("bad_value", ["", "abc", "0", "-1", "3.5", " "])  # pyright: ignore[reportCallIssue]
    def test_each_var_rejects_invalid_values(
        self, monkeypatch: pytest.MonkeyPatch, bad_value: str
    ) -> None:
        from apo.services.telemetry_limits import (
            TelemetryLimitError,
            load_telemetry_transport_limits,
        )

        for var in _BACKEND_LIMIT_VARS:
            _clear_limit_env(monkeypatch)
            monkeypatch.setenv(var, bad_value)
            with pytest.raises(TelemetryLimitError) as exc_info:
                load_telemetry_transport_limits()
            # The error must name the offending variable but not print others.
            assert var in str(exc_info.value)

    def test_error_for_one_var_does_not_leak_other_env_values(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from apo.services.telemetry_limits import (
            TelemetryLimitError,
            load_telemetry_transport_limits,
        )

        _clear_limit_env(monkeypatch)
        monkeypatch.setenv("APO_TELEMETRY_MAX_REQUEST_BYTES", "bad")
        monkeypatch.setenv("APO_OTLP_MAX_SPANS_PER_REQUEST", "12345")
        with pytest.raises(TelemetryLimitError) as exc_info:
            load_telemetry_transport_limits()
        msg = str(exc_info.value)
        assert "APO_TELEMETRY_MAX_REQUEST_BYTES" in msg
        # Must not echo the value of a *different* (valid) variable.
        assert "12345" not in msg


# ---------------------------------------------------------------------------
# Layer 2 helpers: raw ASGI driving of RequestSizeMiddleware
# ---------------------------------------------------------------------------

_OTLP_PATH = "/api/public/otel/v1/traces"


async def _body_echo_app(scope, receive, send):
    """Minimal ASGI app: reads the whole body, responds with its length."""
    from starlette.requests import Request
    from starlette.responses import PlainTextResponse

    request = Request(scope, receive)
    body = await request.body()
    response = PlainTextResponse(f"ok:{len(body)}")
    await response(scope, receive, send)


async def _drive_otlp(
    limits,
    body_chunks,
    *,
    content_length=None,
    receive_delay=0.0,
):
    """Drive RequestSizeMiddleware wrapping the echo app on the OTLP path.

    Returns ``(status_code, response_body, receive_call_count)``.
    """
    from apo.middleware.request_size import RequestSizeMiddleware

    middleware = RequestSizeMiddleware(_body_echo_app, otlp_limits=limits)

    headers = [(b"content-type", b"application/json")]
    if content_length is not None:
        headers.append((b"content-length", str(content_length).encode()))

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": _OTLP_PATH,
        "raw_path": _OTLP_PATH.encode(),
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
        if receive_delay:
            await asyncio.sleep(receive_delay)
        try:
            chunk = next(chunk_iter)
            return {"type": "http.request", "body": chunk, "more_body": True}
        except StopIteration:
            return {"type": "http.request", "body": b"", "more_body": False}

    sent: list[dict] = []  # pyright: ignore[reportMissingTypeArgument]

    async def send(message):
        sent.append(message)

    await middleware(scope, receive, send)

    status = 0
    body = b""
    for msg in sent:
        if msg["type"] == "http.response.start":
            status = msg["status"]
        elif msg["type"] == "http.response.body":
            body += msg.get("body", b"")
    return status, body, receive_count


# ---------------------------------------------------------------------------
# Unit tests 3-5: streamed on-wire byte enforcement + receive deadline
# ---------------------------------------------------------------------------


class TestStreamedByteEnforcement:
    """Acceptance tests 3-4: chunked counting and declared-excess rejection."""

    @pytest.mark.asyncio
    async def test_chunked_body_crossing_limit_returns_413_and_stops_reading(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test 3: no Content-Length, chunks cross 10 MiB → 413, reading stops."""
        from apo.services.telemetry_limits import TelemetryTransportLimits

        _clear_limit_env(monkeypatch)
        limits = TelemetryTransportLimits(
            max_request_bytes=100,
            max_otlp_decompressed_bytes=10_485_760,
            max_otlp_spans_per_request=2048,
            body_timeout_seconds=30,
        )
        # 3 chunks of 40 bytes = 120 total, crosses the 100-byte limit on
        # the third chunk.
        chunks = [b"x" * 40, b"x" * 40, b"x" * 40]

        status, _body, calls = await _drive_otlp(limits, chunks)

        assert status == 413
        # Reading stopped after the over-limit chunk — the final empty chunk
        # (the 4th receive) was never requested.
        assert calls == 3

    @pytest.mark.asyncio
    async def test_declared_excess_rejected_without_consuming_body(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test 4: Content-Length > limit → 413, receive callable untouched."""
        from apo.services.telemetry_limits import TelemetryTransportLimits

        _clear_limit_env(monkeypatch)
        limits = TelemetryTransportLimits(
            max_request_bytes=100,
            max_otlp_decompressed_bytes=10_485_760,
            max_otlp_spans_per_request=2048,
            body_timeout_seconds=30,
        )

        status, _body, calls = await _drive_otlp(
            limits, body_chunks=[b""], content_length=101
        )

        assert status == 413
        # The body was never read — Content-Length alone triggered rejection.
        assert calls == 0


class TestBodyReceiveDeadline:
    """Acceptance test 5: the deadline constrains body receipt only."""

    @pytest.mark.asyncio
    async def test_slow_receive_times_out_with_408(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from apo.services.telemetry_limits import TelemetryTransportLimits

        _clear_limit_env(monkeypatch)
        limits = TelemetryTransportLimits(
            max_request_bytes=10_485_760,
            max_otlp_decompressed_bytes=10_485_760,
            max_otlp_spans_per_request=2048,
            body_timeout_seconds=1,
        )
        # receive_delay exceeds the 1-second deadline.
        status, _body, _calls = await _drive_otlp(
            limits, body_chunks=[b"x" * 10], receive_delay=2.0
        )

        assert status == 408


# ---------------------------------------------------------------------------
# Layer 3 helpers: OTLP payloads
# ---------------------------------------------------------------------------


def _otlp_json(num_spans: int = 1) -> bytes:
    """A minimal valid OTLP/JSON payload with the given span count."""
    spans = [
        {
            "traceId": f"{i:032x}",
            "spanId": f"{i:016x}",
            "name": f"span-{i}",
            "kind": 0,
            "startTimeUnixNano": "1700000000000000000",
            "endTimeUnixNano": "1700000001000000000",
        }
        for i in range(num_spans)
    ]
    return json.dumps({"resourceSpans": [{"scopeSpans": [{"spans": spans}]}]}).encode()


def _gzip_bytes(data: bytes) -> bytes:
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb") as f:
        f.write(data)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Unit tests 6-7: bounded gzip decompression
# ---------------------------------------------------------------------------


class TestBoundedGzip:
    """Acceptance tests 6-7: gzip at limit succeeds; over limit stops."""

    def test_gzip_at_exactly_the_limit_succeeds(self) -> None:
        """Test 6: gzip content expanding to exactly the limit decodes fine."""
        from apo.services.otlp_receiver import decode_otlp_payload
        from apo.services.telemetry_limits import TelemetryTransportLimits

        raw = _otlp_json()
        compressed = _gzip_bytes(raw)
        limits = TelemetryTransportLimits(
            max_request_bytes=len(compressed),
            max_otlp_decompressed_bytes=len(raw),  # exactly the limit
            max_otlp_spans_per_request=2048,
            body_timeout_seconds=30,
        )

        decoded = decode_otlp_payload(
            compressed, "application/json", "gzip", limits=limits
        )
        assert "resourceSpans" in decoded

    def test_gzip_over_the_limit_rejects_immediately(self) -> None:
        """Test 7: expansion beyond the cap rejects without quadratic concat."""
        from apo.services.otlp_receiver import OtlpSizeLimitError, decode_otlp_payload
        from apo.services.telemetry_limits import TelemetryTransportLimits

        raw = _otlp_json()
        compressed = _gzip_bytes(raw)
        limits = TelemetryTransportLimits(
            max_request_bytes=len(compressed),
            max_otlp_decompressed_bytes=len(raw) - 1,  # one byte under
            max_otlp_spans_per_request=2048,
            body_timeout_seconds=30,
        )

        with pytest.raises(OtlpSizeLimitError):
            decode_otlp_payload(
                compressed, "application/json", "gzip", limits=limits
            )


# ---------------------------------------------------------------------------
# Unit test 8: whole-graph span counting
# ---------------------------------------------------------------------------


class TestSpanCounting:
    """Acceptance test 8: span counting covers the entire OTLP graph."""

    def test_count_spans_across_multiple_resource_and_scope_spans(self) -> None:
        from apo.services.otlp_receiver import count_otlp_spans

        # Two scopeSpans in one resourceSpan: 1024 + 1025 = 2049 total.
        big = {
            "resourceSpans": [
                {
                    "scopeSpans": [
                        {"spans": [{"traceId": f"{i:032x}", "spanId": f"{i:016x}"} for i in range(1024)]},
                        {"spans": [{"traceId": f"{(i + 1024):032x}", "spanId": f"{(i + 1024):016x}"} for i in range(1025)]},
                    ]
                }
            ]
        }
        assert count_otlp_spans(big) == 2049


# ---------------------------------------------------------------------------
# Unit test 9: malformed decode creates no failed inbox
# ---------------------------------------------------------------------------


class TestNoFailedInboxOnMalformed:
    """Acceptance test 9: malformed payloads write no durable inbox row."""

    def test_malformed_json_writes_no_inbox_row(self, session: Session) -> None:
        from apo.models.db import OtlpIngestBatchDB
        from apo.services.otlp_receiver import OtlpReceiver

        receiver = OtlpReceiver()
        with pytest.raises(Exception):
            receiver.ingest(
                payload=b"not valid json",
                content_type="application/json",
                project_id="test",
                session=session,
            )
        rows = list(session.exec(select(OtlpIngestBatchDB)).all())
        assert len(rows) == 0

    def test_malformed_protobuf_writes_no_inbox_row(self, session: Session) -> None:
        from apo.models.db import OtlpIngestBatchDB
        from apo.services.otlp_receiver import OtlpReceiver

        receiver = OtlpReceiver()
        with pytest.raises(Exception):
            receiver.ingest(
                payload=b"\x99\x99\x99 garbage protobuf",
                content_type="application/x-protobuf",
                project_id="test",
                session=session,
            )
        rows = list(session.exec(select(OtlpIngestBatchDB)).all())
        assert len(rows) == 0


# ---------------------------------------------------------------------------
# Layer 4: registered OTLP route integration
# ---------------------------------------------------------------------------


@pytest.fixture(name="otlp_client")
def otlp_client_fixture(session: Session):
    """TestClient with auth state injected so the OTLP route admits requests.

    Uses a thin wrapper app that sets ``request.state.project`` and
    ``auth_method="cookie"`` (bypassing scope checks) before delegating to the
    real router. The real RequestSizeMiddleware and receiver enforce the
    transport limits under test.
    """
    from collections.abc import Awaitable, Callable

    from fastapi import FastAPI
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.requests import Request
    from starlette.responses import Response

    from apo.api import app as real_app
    from apo.db import get_session

    test_engine = session.get_bind()
    session.close()

    class InjectOtlpAuth(BaseHTTPMiddleware):
        async def dispatch(
            self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
        ) -> Response:
            request.state.project = "test"
            request.state.auth_method = "cookie"
            return await call_next(request)

    new_app = FastAPI()
    new_app.include_router(real_app.router)
    new_app.add_middleware(InjectOtlpAuth)

    def _session_override():
        with Session(test_engine) as s:
            yield s

    new_app.dependency_overrides[get_session] = _session_override
    client = TestClient(new_app)
    yield client
    client.close()


class TestRouteSpanCountCap:
    """Acceptance tests 12-13: 2049 rejected atomically; 2048 admitted."""

    def test_route_rejects_2049_spans_and_writes_nothing(self, otlp_client: TestClient, session: Session) -> None:
        from apo.models.db import OtlpIngestBatchDB, OtlpSpanDB

        payload = _otlp_json(2049)
        resp = otlp_client.post(
            "/api/public/otel/v1/traces",
            content=payload,
            headers={"content-type": "application/json"},
        )
        assert resp.status_code == 413

        assert len(list(session.exec(select(OtlpIngestBatchDB)).all())) == 0
        assert len(list(session.exec(select(OtlpSpanDB)).all())) == 0

    def test_route_admits_2048_spans(
        self, otlp_client: TestClient, session: Session
    ) -> None:
        payload = _otlp_json(2048)
        resp = otlp_client.post(
            "/api/public/otel/v1/traces",
            content=payload,
            headers={"content-type": "application/json"},
        )
        assert resp.status_code == 200
        # Bound this test's own write load before it ends: the admitted
        # batch's span SQL rides the process's one shared test connection,
        # and an unbounded straggler once leaked 48+ projected run rows
        # into the NEXT test's freshly recreated schema (observed on a slow
        # CI runner as test_run_list_query seeing hex trace ids). Waiting
        # for all 2048 canonical spans also upgrades the test from
        # "route said 200" to "the batch actually landed".
        # The i=0 span carries an all-zero trace id, which the receiver
        # rejects, so 2047 canonical rows is the batch's exact steady state.
        expected = 2047
        deadline = time.monotonic() + 15.0
        while True:
            stored = len(list(session.exec(select(OtlpSpanDB)).all()))
            if stored >= expected:
                break
            assert time.monotonic() < deadline, (
                f"admitted 2048 spans but only {stored} canonical rows landed"
            )
            time.sleep(0.05)
        assert stored == expected


class TestRoutePartialSuccess:
    """Acceptance test 14: admitted batch retains existing partial success."""

    def test_one_valid_one_invalid_span_returns_partial_success(
        self, otlp_client: TestClient
    ) -> None:
        payload = json.dumps({
            "resourceSpans": [{
                "scopeSpans": [{
                    "spans": [
                        {
                            "traceId": "0123456789abcdef0123456789abcdef",
                            "spanId": "0123456789abcdef",
                            "name": "valid",
                            "kind": 0,
                            "startTimeUnixNano": "1700000000000000000",
                            "endTimeUnixNano": "1700000001000000000",
                        },
                        {
                            "traceId": "00000000000000000000000000000000",
                            "spanId": "0000000000000000",
                            "name": "invalid-zero-ids",
                            "kind": 0,
                            "startTimeUnixNano": "1700000000000000000",
                            "endTimeUnixNano": "1700000001000000000",
                        },
                    ]
                }]
            }]
        }).encode()

        resp = otlp_client.post(
            "/api/public/otel/v1/traces",
            content=payload,
            headers={"content-type": "application/json"},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert "partialSuccess" in body
        assert body["partialSuccess"]["rejectedSpans"] == 1
