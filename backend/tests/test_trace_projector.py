# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""Tests for the Trace Projector (SPEC-129 Track 3).

The projector takes canonical ``OtlpSpanDB`` rows, normalizes them via the
Track 2 normalizer, and upserts into the existing ``RunDB``/``LoggedCallDB``
tables. This bridges the canonical OTel store to the dashboard's existing
query layer without requiring a visual rewrite.

Key properties:
  - Tolerates child-before-root ordering
  - Idempotent: projecting the same span twice doesn't duplicate rows
  - Derives run-level data from the root span, not the first batch
  - Preserves all the fields the dashboard renders (input, output, tokens, etc.)
"""

import json
from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select, text
from apo.db import engine, init_db
from apo.models.db import OtlpSpanDB, RunDB, LoggedCallDB
from apo.services.trace_projector import TraceProjector


@pytest.fixture(autouse=True)
def setup_database():
    init_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM run_metrics"))
        session.execute(text("DELETE FROM logged_calls"))
        session.execute(text("DELETE FROM runs"))
        session.execute(text("DELETE FROM otlp_spans"))
        session.execute(text("DELETE FROM otlp_ingest_batches"))
        session.commit()


def _make_canonical_span(
    *,
    trace_id: str,
    span_id: str,
    parent_span_id: str | None = None,
    name: str = "test-span",
    attributes: dict[str, object] | None = None,
    start: str = "2026-07-09T12:00:00Z",
    end: str = "2026-07-09T12:00:01Z",
    project_id: str = "test-project",
) -> OtlpSpanDB:
    return OtlpSpanDB(
        project_id=project_id,
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent_span_id,
        start_time=datetime.fromisoformat(start.replace("Z", "+00:00")),
        end_time=datetime.fromisoformat(end.replace("Z", "+00:00")),
        span_name=name,
        attributes=attributes or {},
        resource={},
        raw_span={},
    )


class TestTraceProjectorBasics:
    """Basic projection: canonical spans → RunDB + LoggedCallDB."""

    def test_project_creates_run_from_root_span(self):
        """A root span (no parent) creates a RunDB row."""
        span = _make_canonical_span(
            trace_id="proj-root-001",
            span_id="root-span-01",
            name="agent.run",
            attributes={"apo.observation.type": "AGENT"},
        )

        projector = TraceProjector()
        with Session(engine) as session:
            projector.project(span, session)
            session.commit()

        with Session(engine) as session:
            run = session.exec(select(RunDB).where(RunDB.id == "proj-root-001")).first()
            assert run is not None
            assert run.project == "test-project"

    def test_project_creates_call_from_each_span(self):
        """Each span becomes a LoggedCallDB row."""
        root = _make_canonical_span(
            trace_id="proj-calls-01",
            span_id="root-c-01",
            attributes={"apo.observation.type": "AGENT"},
        )
        child = _make_canonical_span(
            trace_id="proj-calls-01",
            span_id="child-c-01",
            parent_span_id="root-c-01",
            name="chat gpt-4o",
            attributes={
                "gen_ai.request.model": "gpt-4o",
                "gen_ai.usage.input_tokens": 100,
                "gen_ai.usage.output_tokens": 50,
            },
        )

        projector = TraceProjector()
        with Session(engine) as session:
            projector.project(root, session)
            projector.project(child, session)
            session.commit()

        with Session(engine) as session:
            calls = list(
                session.exec(
                    select(LoggedCallDB).where(LoggedCallDB.run_id == "proj-calls-01")
                )
            )
            assert len(calls) == 2

    def test_project_preserves_hierarchy(self):
        """Parent-child span relationships are preserved in LoggedCallDB."""
        root = _make_canonical_span(
            trace_id="proj-hier-001",
            span_id="root-h-01",
            attributes={"apo.observation.type": "AGENT"},
        )
        child = _make_canonical_span(
            trace_id="proj-hier-001",
            span_id="child-h-01",
            parent_span_id="root-h-01",
            attributes={"gen_ai.tool.name": "search"},
        )

        projector = TraceProjector()
        with Session(engine) as session:
            projector.project(root, session)
            projector.project(child, session)
            session.commit()

        with Session(engine) as session:
            child_call = session.exec(select(LoggedCallDB).where(LoggedCallDB.id == "child-h-01")).first()
            assert child_call is not None
            assert child_call.parent_call_id == "root-h-01"

    def test_project_maps_normalized_fields_to_call(self):
        """The normalizer's output maps to LoggedCallDB columns."""
        span = _make_canonical_span(
            trace_id="proj-fields-01",
            span_id="span-f-01",
            name="chat gpt-4o",
            attributes={
                "gen_ai.request.model": "gpt-4o",
                "gen_ai.usage.input_tokens": 100,
                "gen_ai.usage.output_tokens": 50,
                "gen_ai.input.messages": '[{"role":"user","parts":[{"content":"hi","type":"text"}]}]',
                "gen_ai.output.messages": '[{"role":"assistant","parts":[{"content":"hello","type":"text"}]}]',
            },
        )

        projector = TraceProjector()
        with Session(engine) as session:
            projector.project(span, session)
            session.commit()

        with Session(engine) as session:
            call = session.exec(select(LoggedCallDB).where(LoggedCallDB.id == "span-f-01")).first()
            assert call is not None
            assert call.model == "gpt-4o"
            assert call.prompt_tokens == 100
            assert call.completion_tokens == 50
            assert call.input is not None
            assert "messages" in call.input
            assert call.output is not None
            assert call.output.get("text") == "hello"


class TestTraceProjectorIdempotency:
    """Projecting the same span twice must not duplicate rows."""

    def test_idempotent_projection(self):
        span = _make_canonical_span(
            trace_id="proj-idem-001",
            span_id="span-i-01",
            attributes={"gen_ai.request.model": "gpt-4o"},
        )

        projector = TraceProjector()
        with Session(engine) as session:
            projector.project(span, session)
            session.commit()

        # Project again (simulating a retry/duplicate export)
        with Session(engine) as session:
            projector.project(span, session)
            session.commit()

        with Session(engine) as session:
            calls = list(
                session.exec(
                    select(LoggedCallDB).where(LoggedCallDB.span_id == "span-i-01")
                    if hasattr(LoggedCallDB, "span_id")
                    else select(LoggedCallDB).where(LoggedCallDB.id == "span-i-01")
                )
            )
            assert len(calls) == 1


class TestTraceProjectorChildBeforeRoot:
    """The projector must tolerate children arriving before roots."""

    def test_child_before_root(self):
        child = _make_canonical_span(
            trace_id="proj-cbr-001",
            span_id="child-cbr-1",
            parent_span_id="root-cbr-01",
            attributes={"gen_ai.request.model": "gpt-4o"},
        )
        root = _make_canonical_span(
            trace_id="proj-cbr-001",
            span_id="root-cbr-01",
            attributes={"apo.observation.type": "AGENT"},
        )

        projector = TraceProjector()
        with Session(engine) as session:
            # Child first
            projector.project(child, session)
            # Root second
            projector.project(root, session)
            session.commit()

        with Session(engine) as session:
            run = session.exec(select(RunDB).where(RunDB.id == "proj-cbr-001")).first()
            assert run is not None
            calls = list(
                session.exec(
                    select(LoggedCallDB).where(LoggedCallDB.run_id == "proj-cbr-001")
                )
            )
            assert len(calls) == 2
