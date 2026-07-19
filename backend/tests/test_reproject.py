# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""Tests for the reproject endpoint (SPEC-129 Criterion #2).

The replay capability lets you re-project canonical spans through an updated
normalizer without re-ingesting the raw OTLP payload. This proves the canonical
store is the source of truth and projections are derived/rebuildable.
"""

import json
from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select, text
from apo.db import engine, init_db
from apo.models.db import OtlpSpanDB, RunDB, LoggedCallDB
from apo.services.reproject import reproject_trace
from apo.services.otlp_receiver import OtlpReceiver


@pytest.fixture(autouse=True)
def setup_database():
    init_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM call_metrics"))
        session.execute(text("DELETE FROM run_metrics"))
        session.execute(text("DELETE FROM logged_calls"))
        session.execute(text("DELETE FROM runs"))
        session.execute(text("DELETE FROM otlp_spans"))
        session.execute(text("DELETE FROM otlp_ingest_batches"))
        session.commit()


def _ingest_trace() -> str:
    """Ingest a trace with 2 spans and return the trace_id."""
    payload = json.dumps({
        "resourceSpans": [{
            "scopeSpans": [{
                "spans": [
                    {
                        "traceId": "a1b2c3d4e5f6a1b2a1b2c3d4e5f6a1b2",
                        "spanId": "a1b2c3d4e5f6a1b2",
                        "name": "agent.run",
                        "startTime": "2026-07-10T12:00:00Z",
                        "endTime": "2026-07-10T12:00:05Z",
                        "attributes": [
                            {"key": "apo.observation.type", "value": {"stringValue": "AGENT"}},
                        ],
                    },
                    {
                        "traceId": "a1b2c3d4e5f6a1b2a1b2c3d4e5f6a1b2",
                        "spanId": "b2c3d4e5f6a7b2c3",
                        "parentSpanId": "a1b2c3d4e5f6a1b2",
                        "name": "chat gpt-4o",
                        "startTime": "2026-07-10T12:00:01Z",
                        "endTime": "2026-07-10T12:00:03Z",
                        "attributes": [
                            {"key": "gen_ai.request.model", "value": {"stringValue": "gpt-4o"}},
                            {"key": "gen_ai.usage.input_tokens", "value": {"intValue": "100"}},
                            {"key": "gen_ai.usage.output_tokens", "value": {"intValue": "50"}},
                        ],
                    },
                ],
            }],
        }],
    }).encode()

    receiver = OtlpReceiver()
    with Session(engine) as session:
        result = receiver.ingest(
            payload=payload,
            content_type="application/json",
            project_id="reproject-test",
            session=session,
        )
    assert result.accepted == 2
    return "a1b2c3d4e5f6a1b2a1b2c3d4e5f6a1b2"


class TestReprojectTrace:
    """Re-project canonical spans into RunDB/LoggedCallDB."""

    def test_reproject_creates_projection(self):
        """Reprojecting canonical spans creates RunDB + LoggedCallDB rows."""
        trace_id = _ingest_trace()

        # Delete the projection (simulate a mapper change that broke projections)
        with Session(engine) as session:
            session.exec(text("DELETE FROM call_metrics"))
            session.exec(text("DELETE FROM run_metrics"))
            session.exec(text("DELETE FROM logged_calls"))
            session.exec(text("DELETE FROM runs"))
            session.commit()

        # Verify projection is gone
        with Session(engine) as session:
            assert session.exec(select(RunDB).where(RunDB.id == trace_id)).first() is None

        # Reproject from canonical spans
        count = reproject_trace(trace_id, project_id="reproject-test")
        assert count == 2  # 2 spans projected

        # Verify projection exists again
        with Session(engine) as session:
            run = session.exec(select(RunDB).where(RunDB.id == trace_id, RunDB.project == "reproject-test")).first()
            assert run is not None
            assert run.project == "reproject-test"

            calls = list(session.exec(
                text("SELECT * FROM logged_calls WHERE run_id = :tid"),
                params={"tid": trace_id},
            ))
            assert len(calls) == 2

    def test_reproject_is_idempotent(self):
        """Reprojecting an already-projected trace doesn't duplicate rows."""
        trace_id = _ingest_trace()

        # First reprojection
        count1 = reproject_trace(trace_id, project_id="reproject-test")
        assert count1 == 2

        # Second reprojection — should update, not duplicate
        count2 = reproject_trace(trace_id, project_id="reproject-test")
        assert count2 == 2

        with Session(engine) as session:
            calls = list(session.exec(
                text("SELECT * FROM logged_calls WHERE run_id = :tid"),
                params={"tid": trace_id},
            ))
            assert len(calls) == 2  # not 4

    def test_reproject_updates_after_canonical_change(self):
        """If canonical span attributes change, reprojection picks up the new values."""
        trace_id = _ingest_trace()

        # Mutate a canonical span's model attribute (simulates a mapper fix)
        with Session(engine) as session:
            from sqlmodel import select as _select
            canonical = session.exec(
                _select(OtlpSpanDB).where(
                    OtlpSpanDB.project_id == "reproject-test",
                    OtlpSpanDB.trace_id == trace_id,
                    OtlpSpanDB.span_id == "b2c3d4e5f6a7b2c3",
                )
            ).first()
            assert canonical is not None
            assert canonical.attributes is not None
            attrs = dict(canonical.attributes)
            attrs["gen_ai.request.model"] = "gpt-4.1"
            canonical.attributes = attrs
            session.add(canonical)
            session.commit()

        # Reproject
        reproject_trace(trace_id, project_id="reproject-test")

        # Verify the projection has the updated model
        with Session(engine) as session:
            call = session.exec(
                text("SELECT model FROM logged_calls WHERE id = 'b2c3d4e5f6a7b2c3'")
            ).first()
            assert call is not None
            assert call[0] == "gpt-4.1"

    def test_reproject_nonexistent_trace_returns_zero(self):
        """Reprojecting a trace that doesn't exist returns 0."""
        count = reproject_trace("nonexistent-trace-id", project_id="test")
        assert count == 0
