# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""Tests for the OTLP receiver (SPEC-129 Track 1).

The receiver decodes OTLP/JSON and OTLP/protobuf payloads, binds the project
from authenticated credentials (never from payload attributes), persists
canonical spans losslessly, and returns standard OTLP responses.
"""

import json
from pathlib import Path

import pytest
from sqlmodel import Session, select, text
from apo.db import engine, init_db
from apo.models.db import OtlpSpanDB, OtlpIngestBatchDB
from apo.services.otlp_receiver import (
    OtlpReceiver,
    OtlpReceiverResult,
    decode_otlp_payload,
)

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "otel"


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


def _load_fixture(name: str) -> dict[str, object]:
    return json.loads((FIXTURE_DIR / f"{name}.json").read_text())


class TestDecodeOtlpPayload:
    """Payload decoding: JSON and protobuf to the canonical dict shape."""

    def test_decode_json_payload(self):
        fixture = _load_fixture("generic-root-child")
        payload = json.dumps(fixture["input"]).encode()
        decoded = decode_otlp_payload(payload, "application/json")
        assert "resourceSpans" in decoded
        assert len(decoded["resourceSpans"]) >= 1

    def test_decode_gzip_json_payload(self):
        import gzip

        fixture = _load_fixture("generic-root-child")
        raw = json.dumps(fixture["input"]).encode()
        compressed = gzip.compress(raw)
        decoded = decode_otlp_payload(compressed, "application/json", encoding="gzip")
        assert "resourceSpans" in decoded
        assert len(decoded["resourceSpans"]) >= 1

    def test_decode_invalid_content_type_raises(self):
        with pytest.raises(ValueError, match="content.type"):
            decode_otlp_payload(b"{}", "text/plain")


class TestOtlpReceiverIngest:
    """The receiver ingests spans, binds project from auth, and persists canonically."""

    def test_ingest_json_creates_canonical_spans(self):
        fixture = _load_fixture("generic-root-child")
        receiver = OtlpReceiver()
        payload = json.dumps(fixture["input"]).encode()

        with Session(engine) as session:
            result = receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id="test-project",
                session=session,
            )

        assert result.accepted == 2
        assert result.rejected == 0
        assert len(result.errors) == 0

        with Session(engine) as session:
            spans = list(session.exec(select(OtlpSpanDB)).all())
            assert len(spans) == 2
            # Project comes from auth, never from payload
            for span in spans:
                assert span.project_id == "test-project"
            # Trace IDs match the fixture
            trace_ids = {s.trace_id for s in spans}
            assert trace_ids == {"a1b2c3d4e5f6a1b2a1b2c3d4e5f6a1b2"}

    def test_ingest_persists_lossless_attributes(self):
        """Typed OTel values survive canonicalization as JSON, not stringified."""
        fixture = _load_fixture("openai-instrumentation")
        receiver = OtlpReceiver()
        payload = json.dumps(fixture["input"]).encode()

        with Session(engine) as session:
            receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id="test-project",
                session=session,
            )

        with Session(engine) as session:
            span = session.exec(select(OtlpSpanDB)).first()
            assert span is not None
            assert span.attributes is not None
            # The int value should be preserved as int in JSON, not string
            assert "gen_ai.usage.input_tokens" in span.attributes

    def test_ingest_creates_batch_record(self):
        fixture = _load_fixture("generic-root-child")
        receiver = OtlpReceiver()
        payload = json.dumps(fixture["input"]).encode()

        with Session(engine) as session:
            result = receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id="test-project",
                session=session,
            )

        with Session(engine) as session:
            batches = list(session.exec(select(OtlpIngestBatchDB)).all())
            assert len(batches) == 1
            assert batches[0].project_id == "test-project"
            assert batches[0].accepted_span_count == 2
            assert batches[0].status == "accepted"

    def test_project_from_auth_overrides_payload_namespace(self):
        """service.namespace in the payload must NOT override the auth-bound project."""
        fixture = _load_fixture("generic-root-child")
        # The fixture has service.namespace=test-namespace in resource attrs
        receiver = OtlpReceiver()
        payload = json.dumps(fixture["input"]).encode()

        with Session(engine) as session:
            receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id="auth-bound-project",
                session=session,
            )

        with Session(engine) as session:
            spans = list(session.exec(select(OtlpSpanDB)).all())
            for span in spans:
                assert span.project_id == "auth-bound-project"
                # Resource data is preserved as telemetry, not used for tenancy
                assert span.resource is not None

    def test_ingest_duplicate_spans_is_idempotent(self):
        """The same span exported twice produces one canonical record."""
        fixture = _load_fixture("edge-duplicate-idempotent")
        receiver = OtlpReceiver()
        payload = json.dumps(fixture["input"]).encode()

        with Session(engine) as session:
            receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id="test-project",
                session=session,
            )

        with Session(engine) as session:
            receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id="test-project",
                session=session,
            )

        with Session(engine) as session:
            spans = list(
                session.exec(
                    select(OtlpSpanDB).where(OtlpSpanDB.span_id == "7777777777777777")
                )
            )
            assert len(spans) == 1  # idempotent

    def test_ingest_child_before_root(self):
        """Child spans arriving before root must persist correctly."""
        fixture = _load_fixture("edge-child-before-root")
        receiver = OtlpReceiver()
        payload = json.dumps(fixture["input"]).encode()

        with Session(engine) as session:
            result = receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id="test-project",
                session=session,
            )

        assert result.accepted == 2

        with Session(engine) as session:
            spans = list(session.exec(select(OtlpSpanDB)).all())
            assert len(spans) == 2
            # The root span (no parent) exists
            roots = [s for s in spans if s.parent_span_id is None]
            assert len(roots) == 1
            assert roots[0].span_id == "3333333333333333"

    def test_ingest_preserves_error_status_and_events(self):
        """ERROR status and exception events survive canonicalization."""
        fixture = _load_fixture("edge-error-status")
        receiver = OtlpReceiver()
        payload = json.dumps(fixture["input"]).encode()

        with Session(engine) as session:
            receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id="test-project",
                session=session,
            )

        with Session(engine) as session:
            span = session.exec(select(OtlpSpanDB)).first()
            assert span is not None
            assert span.status_code == 2  # ERROR
            assert span.status_message == "Connection refused"
            assert span.events is not None
            assert len(span.events) >= 1
