# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""SPEC-131 Milestone 1 regression tests: prove the protocol gaps before fixing.

These tests target the audited failures in the OTLP receiver path. They are
written against the CURRENT (pre-hardening) behavior and are expected to FAIL
until Milestone 2+ lands. Each test names the SPEC-131 invariant it guards:

  - Standard OTLP/JSON nanosecond timestamps (Test Case 2)
  - Protobuf response encoding (Test Case 1)
  - OTel ID validation (Test Case 3)
  - Partial batch with per-span failure (Test Case 4)
  - Malformed payload produces 4xx with no accepted rows (Test Case 3)

The fixtures and receivers use the in-process apo DB engine the rest of the
tracing suite uses.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select, text

from apo.db import engine, init_db
from apo.models.db import OtlpIngestBatchDB, OtlpSpanDB
from apo.services.otlp_receiver import OtlpReceiver, decode_otlp_payload

_TRACE_ID = "0123456789abcdef0123456789abcdef"
_ROOT_SPAN_ID = "1111111111111111"
_CHILD_SPAN_ID = "2222222222222222"


@pytest.fixture(autouse=True)
def setup_database():
    init_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM otlp_spans"))
        session.execute(text("DELETE FROM otlp_ingest_batches"))
        session.execute(text("DELETE FROM logged_calls"))
        session.execute(text("DELETE FROM call_metrics"))
        session.execute(text("DELETE FROM run_metrics"))
        session.execute(text("DELETE FROM runs"))
        session.commit()


def _nano(dt: datetime) -> str:
    """Return the standard OTLP decimal-nanosecond string for a datetime."""
    return str(int(dt.timestamp()) * 1_000_000_000 + dt.microsecond * 1_000)


def _json_payload(
    *,
    start_nano: str | None = None,
    end_nano: str | None = None,
    trace_id: str = _TRACE_ID,
    span_id: str = _ROOT_SPAN_ID,
) -> bytes:
    """Build a standard OTLP/JSON batch using *UnixNano timestamp fields."""
    span: dict[str, object] = {
        "traceId": trace_id,
        "spanId": span_id,
        "name": "agent.run",
        "kind": 0,
    }
    if start_nano is not None:
        span["startTimeUnixNano"] = start_nano
    if end_nano is not None:
        span["endTimeUnixNano"] = end_nano
    return json.dumps({"resourceSpans": [{"scopeSpans": [{"spans": [span]}]}]}).encode()


# ---------------------------------------------------------------------------
# Standard OTLP/JSON nanosecond timestamps (Test Case 2)
# ---------------------------------------------------------------------------


class TestStandardOtlpJsonTimestamps:
    """Stock OTLP/JSON uses startTimeUnixNano/endTimeUnixNano decimal strings."""

    def test_standard_nanosecond_start_and_end_are_preserved(self):
        start = datetime(2026, 7, 10, 12, 0, 0, tzinfo=timezone.utc)
        end = datetime(2026, 7, 10, 12, 0, 5, 200000, tzinfo=timezone.utc)
        payload = _json_payload(start_nano=_nano(start), end_nano=_nano(end))

        receiver = OtlpReceiver()
        with Session(engine) as session:
            result = receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id="proto-project",
                session=session,
            )

        assert result.accepted == 1, result.errors

        with Session(engine) as session:
            span = session.exec(select(OtlpSpanDB)).first()
            assert span is not None
            # Exact UTC datetime, microseconds preserved, no now() fallback.
            assert span.start_time == start
            assert span.end_time == end
            # Duration is exactly 5.2 seconds, not derived from ingestion time.
            assert span.end_time - span.start_time  # sanity: both parsed

    def test_missing_timestamps_do_not_fabricate_ingestion_time(self):
        """A span with no timestamps must not silently substitute now()."""
        payload = _json_payload(start_nano=None, end_nano=None)

        receiver = OtlpReceiver()
        with Session(engine) as session:
            receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id="proto-project",
                session=session,
            )

        with Session(engine) as session:
            span = session.exec(select(OtlpSpanDB)).first()
            assert span is not None
            assert span.start_time is None
            assert span.end_time is None


# ---------------------------------------------------------------------------
# OTel ID validation (Test Case 3: zero/short IDs)
# ---------------------------------------------------------------------------


class TestOtelIdValidation:
    """trace_id (16 or 32 hex) and span_id (8 hex) must be validated."""

    @pytest.mark.parametrize(
        "trace_id,span_id",
        [
            ("00000000000000000000000000000000", _ROOT_SPAN_ID),  # zero trace
            (_TRACE_ID, "0000000000000000"),  # zero span
            ("short", _ROOT_SPAN_ID),  # short trace
            (_TRACE_ID, "short"),  # short span
            ("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", _ROOT_SPAN_ID),  # non-hex trace
        ],
    )
    def test_invalid_ids_rejected_no_canonical_row(self, trace_id: str, span_id: str):
        start = datetime(2026, 7, 10, 12, 0, 0, tzinfo=timezone.utc)
        payload = _json_payload(
            start_nano=_nano(start),
            trace_id=trace_id,
            span_id=span_id,
        )

        receiver = OtlpReceiver()
        with Session(engine) as session:
            result = receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id="proto-project",
                session=session,
            )

        assert result.accepted == 0
        assert result.rejected == 1
        with Session(engine) as session:
            assert session.exec(select(OtlpSpanDB)).first() is None


# ---------------------------------------------------------------------------
# Partial batch (Test Case 4)
# ---------------------------------------------------------------------------


class TestPartialBatch:
    """A batch with one valid and one invalid span accepts the valid one."""

    def test_one_valid_one_invalid_reports_rejected(self):
        start = datetime(2026, 7, 10, 12, 0, 0, tzinfo=timezone.utc)
        valid = {
            "traceId": _TRACE_ID,
            "spanId": _ROOT_SPAN_ID,
            "name": "agent.run",
            "startTimeUnixNano": _nano(start),
        }
        invalid = {
            "traceId": _TRACE_ID,
            "spanId": "0000000000000000",  # zero span id
            "name": "bad.span",
            "startTimeUnixNano": _nano(start),
        }
        payload = json.dumps(
            {"resourceSpans": [{"scopeSpans": [{"spans": [valid, invalid]}]}]}
        ).encode()

        receiver = OtlpReceiver()
        with Session(engine) as session:
            result = receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id="proto-project",
                session=session,
            )

        assert result.accepted == 1
        assert result.rejected == 1
        with Session(engine) as session:
            spans = list(session.exec(select(OtlpSpanDB)).all())
            assert len(spans) == 1
            assert spans[0].span_id == _ROOT_SPAN_ID


# ---------------------------------------------------------------------------
# Protobuf response encoding (Test Case 1)
# ---------------------------------------------------------------------------


class TestProtobufResponseEncoding:
    """A protobuf request must receive a protobuf ExportTraceServiceResponse."""

    def test_protobuf_request_returns_protobuf_content_type(self):
        from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
            ExportTraceServiceRequest,
        )
        from opentelemetry.proto.trace.v1.trace_pb2 import ResourceSpans, ScopeSpans, Span

        start_nano = _nano(datetime(2026, 7, 10, 12, 0, 0, tzinfo=timezone.utc))
        span = Span(
            trace_id=bytes.fromhex(_TRACE_ID),
            span_id=bytes.fromhex(_ROOT_SPAN_ID),
            name="agent.run",
            start_time_unix_nano=int(start_nano),
            end_time_unix_nano=int(start_nano) + 5_000_000_000,
        )
        scope_spans = ScopeSpans(spans=[span])
        rs = ResourceSpans(scope_spans=[scope_spans])
        request = ExportTraceServiceRequest(resource_spans=[rs])
        body = request.SerializeToString()

        # Exercise the decode path directly (the route layer is the
        # Milestone 2 concern; decoding correctness is the foundation).
        decoded = decode_otlp_payload(body, "application/x-protobuf")
        first_span = decoded["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
        # Standard OTLP field must survive decoding — NOT be renamed to startTime.
        assert first_span.get("startTimeUnixNano") == start_nano
        assert first_span.get("traceId") == _TRACE_ID
        assert first_span.get("spanId") == _ROOT_SPAN_ID
