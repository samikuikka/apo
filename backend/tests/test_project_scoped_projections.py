# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""Tests for project-scoped projection identities (SPEC-133 M4).

Two projects must be able to project the same OTel trace ID independently.
Surrogate ``row_id`` primary keys plus ``UNIQUE(project, id)`` constraints
make this possible: each project owns its own projection row for the same
public OTel id.
"""

import json
from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select, text
from apo.db import engine, init_db
from apo.models.db import (
    OtlpIngestBatchDB,
    OtlpSpanDB,
    RunDB,
    LoggedCallDB,
)
from apo.services.otlp_receiver import OtlpReceiver

_SHARED_TRACE = "aabbccddeeff00112233445566778899"
_SHARED_SPAN_A = "aabb000000000000"
_SHARED_SPAN_B = "bbbb000000000000"
_PROJECT_A = "project-alpha"
_PROJECT_B = "project-beta"


@pytest.fixture(autouse=True)
def setup_database():
    init_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM call_metrics"))
        session.execute(text("DELETE FROM run_metrics"))
        session.execute(text("DELETE FROM logged_calls"))
        session.execute(text("DELETE FROM otlp_spans"))
        session.execute(text("DELETE FROM otlp_ingest_batches"))
        session.execute(text("DELETE FROM runs"))
        session.commit()


def _make_otlp_payload(trace_id: str, span_id: str, parent_span_id: str | None = None) -> bytes:
    attrs = [{"key": "apo.observation.type", "value": {"stringValue": "AGENT"}}]
    return json.dumps({
        "resourceSpans": [{
            "scopeSpans": [{
                "spans": [{
                    "traceId": trace_id,
                    "spanId": span_id,
                    **({"parentSpanId": parent_span_id} if parent_span_id else {}),
                    "name": "test-span",
                    "startTime": "2026-07-12T12:00:00Z",
                    "endTime": "2026-07-12T12:00:01Z",
                    "attributes": attrs,
                }],
            }],
        }],
    }).encode()


class TestProjectScopedProjection:
    """Two projects can project the same trace ID independently."""

    def test_two_projects_same_trace_id_both_succeed(self):
        """Project A and Project B both ingest the same trace ID.
        Both should create their own RunDB + LoggedCallDB rows.
        Neither should be rejected."""
        receiver = OtlpReceiver()

        # Project A ingests the trace
        payload_a = _make_otlp_payload(_SHARED_TRACE, _SHARED_SPAN_A)
        with Session(engine) as session:
            result_a = receiver.ingest(
                payload=payload_a,
                content_type="application/json",
                project_id=_PROJECT_A,
                session=session,
            )
        assert result_a.accepted == 1

        # Project B ingests the same trace ID
        payload_b = _make_otlp_payload(_SHARED_TRACE, _SHARED_SPAN_B)
        with Session(engine) as session:
            result_b = receiver.ingest(
                payload=payload_b,
                content_type="application/json",
                project_id=_PROJECT_B,
                session=session,
            )
        assert result_b.accepted == 1

        # Both projects should have their own RunDB
        with Session(engine) as session:
            run_a = session.exec(
                select(RunDB).where(
                    RunDB.id == _SHARED_TRACE,
                    RunDB.project == _PROJECT_A,
                )
            ).first()
            run_b = session.exec(
                select(RunDB).where(
                    RunDB.id == _SHARED_TRACE,
                    RunDB.project == _PROJECT_B,
                )
            ).first()

            assert run_a is not None, "Project A should have a run"
            assert run_b is not None, "Project B should have a run"
            assert run_a.project == _PROJECT_A
            assert run_b.project == _PROJECT_B

            # Both should have their own LoggedCallDB
            call_a = session.exec(
                select(LoggedCallDB).where(
                    LoggedCallDB.id == _SHARED_SPAN_A,
                    LoggedCallDB.project == _PROJECT_A,
                )
            ).first()
            call_b = session.exec(
                select(LoggedCallDB).where(
                    LoggedCallDB.id == _SHARED_SPAN_B,
                    LoggedCallDB.project == _PROJECT_B,
                )
            ).first()

            assert call_a is not None, "Project A should have a call"
            assert call_b is not None, "Project B should have a call"

    def test_same_project_same_trace_is_idempotent(self):
        """Re-projecting the same trace in the same project updates, not duplicates."""
        receiver = OtlpReceiver()
        payload = _make_otlp_payload(_SHARED_TRACE, _SHARED_SPAN_A)

        with Session(engine) as session:
            receiver.ingest(payload=payload, content_type="application/json",
                           project_id=_PROJECT_A, session=session)
        with Session(engine) as session:
            receiver.ingest(payload=payload, content_type="application/json",
                           project_id=_PROJECT_A, session=session)

        with Session(engine) as session:
            runs = session.exec(
                select(RunDB).where(RunDB.project == _PROJECT_A, RunDB.id == _SHARED_TRACE)
            ).all()
            assert len(runs) == 1  # idempotent — one row, not two

    def test_two_projects_different_spans_same_trace(self):
        """Two projects ingest different spans of the same trace."""
        receiver = OtlpReceiver()

        # Project A: root span
        payload_a = _make_otlp_payload(_SHARED_TRACE, _SHARED_SPAN_A)
        with Session(engine) as session:
            receiver.ingest(payload=payload_a, content_type="application/json",
                           project_id=_PROJECT_A, session=session)

        # Project B: child span (same trace, different span)
        payload_b = _make_otlp_payload(_SHARED_TRACE, _SHARED_SPAN_B, parent_span_id=_SHARED_SPAN_A)
        with Session(engine) as session:
            receiver.ingest(payload=payload_b, content_type="application/json",
                           project_id=_PROJECT_B, session=session)

        with Session(engine) as session:
            # Both projects have runs for the same trace
            runs = session.exec(
                select(RunDB).where(RunDB.id == _SHARED_TRACE)
            ).all()
            assert len(runs) == 2
            projects = {r.project for r in runs}
            assert projects == {_PROJECT_A, _PROJECT_B}
