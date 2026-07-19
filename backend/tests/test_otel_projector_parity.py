# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""SPEC-129 Track 6 Phase 1: canonical-path feature parity regression tests.

These prove the OTLP canonical projector does everything the legacy ingestion
path did, so legacy callers can be migrated onto it and the legacy code
removed. Each test targets one capability the projector must gain:

  1a. Live SSE broadcasting (trace:created / span:created / span:updated /
      trace:completed) — the dashboard's live trace stream.
  1b. Score routing — apo.score sentinel spans → RunMetricDB/CallMetricDB.
  1c. Cost + aggregate metrics — calculate_cost_for_model, total_tokens,
      run-level aggregates on completion.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select, text

from apo.db import engine, init_db
from apo.models.db import (
    CallMetricDB,
    LoggedCallDB,
    OtlpSpanDB,
    RunDB,
    RunMetricDB,
)
from apo.models.trace_ingestion import TraceIngestionContext
from apo.services.otlp_receiver import OtlpReceiver
from apo.services.trace_projector import TraceProjector
from apo.services.otel_normalization import normalize_span

_PROJECT = "parity-project"
_TRACE = "0123456789abcdef0123456789abcdef"
_ROOT_SPAN = "1111111111111111"
_CHILD_SPAN = "2222222222222222"


@pytest.fixture(autouse=True)
def setup_database():
    init_db()
    yield
    with Session(engine) as session:
        for table in (
            "call_metrics",
            "run_metrics",
            "logged_calls",
            "runs",
            "otlp_spans",
            "otlp_ingest_batches",
        ):
            session.execute(text(f"DELETE FROM {table}"))
        session.commit()


def _make_span(
    *,
    trace_id: str = _TRACE,
    span_id: str = _ROOT_SPAN,
    parent_span_id: str | None = None,
    name: str = "agent.run",
    attributes: dict[str, object] | None = None,
    project_id: str = _PROJECT,
    start: datetime | None = None,
    end: datetime | None = None,
) -> OtlpSpanDB:
    start = start or datetime(2026, 7, 11, 12, 0, 0, tzinfo=timezone.utc)
    end = end or datetime(2026, 7, 11, 12, 0, 5, tzinfo=timezone.utc)
    return OtlpSpanDB(
        project_id=project_id,
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent_span_id,
        start_time=start,
        end_time=end,
        span_name=name,
        attributes=attributes or {"apo.observation.type": "AGENT"},
        resource={},
        raw_span={},
    )


def _ingest_span(span: OtlpSpanDB) -> None:
    """Persist + project a canonical span directly through the projector."""
    with Session(engine) as session:
        session.add(span)
        session.flush()
        projector = TraceProjector()
        projector.project(span, session)
        session.commit()


# ===========================================================================
# Phase 1a: SSE broadcasting
# ===========================================================================


class TestProjectorBroadcasts:
    """The projector must fire SSE events the dashboard's useTraceStream parses.

    These tests are async so the projector runs inside a live event loop and
    its ``loop.create_task(broadcast)`` can fire.
    """

    async def test_root_span_broadcasts_trace_created(self):
        from apo.services import trace_broadcaster as tb_module

        tb_module.reset_trace_broadcaster()
        broadcaster = await tb_module.get_trace_broadcaster()
        events: list[str] = []
        received = asyncio.Event()

        async def capture() -> None:
            async for msg in broadcaster.subscribe(_TRACE):
                events.append(msg)
                received.set()

        capture_task = asyncio.ensure_future(capture())
        # Let the subscriber register.
        await asyncio.sleep(0.05)

        # Project a root span — runs in this loop, so the broadcast fires.
        _ingest_span(_make_span(span_id=_ROOT_SPAN))

        # Yield control so the broadcast task can run.
        await asyncio.sleep(0.1)

        capture_task.cancel()
        try:
            await capture_task
        except asyncio.CancelledError:
            pass

        joined = "".join(events)
        assert "trace:created" in joined, f"expected trace:created, got: {joined!r}"

    async def test_child_span_broadcasts_span_created(self):
        """A child span projection fires a span:created SSE event."""
        from apo.services import trace_broadcaster as tb_module

        tb_module.reset_trace_broadcaster()
        broadcaster = await tb_module.get_trace_broadcaster()

        # Root first (outside the subscriber window).
        _ingest_span(_make_span(span_id=_ROOT_SPAN, name="agent.run"))

        events: list[str] = []
        received = asyncio.Event()

        async def capture() -> None:
            async for msg in broadcaster.subscribe(_TRACE):
                events.append(msg)
                received.set()

        capture_task = asyncio.ensure_future(capture())
        await asyncio.sleep(0.05)

        # Now project a child — should broadcast span:created.
        _ingest_span(
            _make_span(
                span_id=_CHILD_SPAN,
                parent_span_id=_ROOT_SPAN,
                name="chat gpt-4o",
                attributes={"gen_ai.request.model": "gpt-4o"},
            )
        )
        await asyncio.sleep(0.1)

        capture_task.cancel()
        try:
            await capture_task
        except asyncio.CancelledError:
            pass

        joined = "".join(events)
        assert "span:created" in joined, f"expected span:created, got: {joined!r}"
        assert "gpt-4o" in joined, "model field must be in the SSE body"


# ===========================================================================
# Phase 1b: Score routing
# ===========================================================================


class TestProjectorScoreRouting:
    """An apo.score sentinel span routes to the metrics tables, not a fake call."""

    def test_score_span_creates_trace_metric_not_call(self):
        # A trace-level score arrives after the run exists.
        _ingest_span(_make_span(span_id=_ROOT_SPAN, name="agent.run"))
        span = _make_span(
            span_id="3333333333333333",
            attributes={
                "apo.score": True,
                "apo.score.name": "helpfulness",
                "apo.score.value": 0.85,
                "apo.score.data_type": "NUMERIC",
            },
        )
        _ingest_span(span)

        with Session(engine) as session:
            # No LoggedCallDB should be created for a score span.
            calls = list(
                session.exec(
                    select(LoggedCallDB).where(LoggedCallDB.id == "3333333333333333")
                )
            )
            assert calls == [], "score span must not become a LoggedCallDB row"

            # A RunMetricDB (trace-level score) must exist.
            metrics = list(
                session.exec(
                    select(RunMetricDB).where(RunMetricDB.metric_name == "helpfulness")
                )
            )
            assert len(metrics) == 1
            assert metrics[0].score == pytest.approx(0.85)


# ===========================================================================
# Phase 1c: Cost + aggregate metrics
# ===========================================================================


class TestProjectorCostAndAggregates:
    """The projector computes cost and aggregate metrics like the legacy path."""

    def test_projected_call_has_total_tokens(self):
        span = _make_span(
            span_id=_CHILD_SPAN,
            parent_span_id=_ROOT_SPAN,
            attributes={
                "gen_ai.request.model": "gpt-4o",
                "gen_ai.usage.input_tokens": 100,
                "gen_ai.usage.output_tokens": 50,
            },
        )
        _ingest_span(span)

        with Session(engine) as session:
            call = session.exec(
                select(LoggedCallDB).where(
                    LoggedCallDB.id == _CHILD_SPAN,
                    LoggedCallDB.project == _PROJECT,
                )
            ).first()
            assert call is not None
            assert call.total_tokens == 150
            # A correctly-formed GenAI span (model + usage) must produce cost.
            # gpt-4o: (100 * 2.50 + 50 * 10.00) / 1_000_000 = 0.00075
            assert call.calculated_cost is not None
            assert call.calculated_cost == pytest.approx(0.00075)

    def test_root_span_completion_computes_run_aggregates(self):
        """When the root span completes, run-level aggregates are computed."""
        # Project a generation child first.
        child = _make_span(
            span_id=_CHILD_SPAN,
            parent_span_id=_ROOT_SPAN,
            attributes={
                "gen_ai.request.model": "gpt-4o",
                "gen_ai.usage.input_tokens": 100,
                "gen_ai.usage.output_tokens": 50,
            },
        )
        _ingest_span(child)
        # Then the root (completes the run).
        _ingest_span(_make_span(span_id=_ROOT_SPAN, name="agent.run"))

        with Session(engine) as session:
            run = session.exec(
                select(RunDB).where(
                    RunDB.id == _TRACE,
                    RunDB.project == _PROJECT,
                )
            ).first()
            assert run is not None
            assert run.completed_at is not None
            # Aggregate metrics on the run.
            agg = list(
                session.exec(
                    select(RunMetricDB).where(
                        RunMetricDB.run_id == _TRACE,
                        RunMetricDB.metric_type == "aggregate",
                    )
                )
            )
            agg_names = {m.metric_name for m in agg}
            assert "total_tokens" in agg_names

    def test_projected_run_has_call_count_and_primary_model(self):
        """The projector must populate run.call_count and run.primary_model
        from the child spans, so the traces list shows real values instead
        of 0 / NULL (the defaults)."""
        # Project a generation child with a model.
        child = _make_span(
            span_id=_CHILD_SPAN,
            parent_span_id=_ROOT_SPAN,
            attributes={
                "gen_ai.request.model": "gpt-4o",
                "gen_ai.usage.input_tokens": 100,
                "gen_ai.usage.output_tokens": 50,
            },
        )
        _ingest_span(child)
        # Complete the run with the root span.
        _ingest_span(_make_span(span_id=_ROOT_SPAN, name="agent.run"))

        with Session(engine) as session:
            run = session.exec(
                select(RunDB).where(
                    RunDB.id == _TRACE,
                    RunDB.project == _PROJECT,
                )
            ).first()
            assert run is not None
            # call_count must reflect the number of projected calls.
            assert run.call_count > 0
            # primary_model must be set from the child GENERATION span,
            # even though the root span has no model attribute.
            assert run.primary_model == "gpt-4o"
