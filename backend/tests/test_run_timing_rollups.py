"""Issue #309: run-level reasoning and per-call timing rollups.

The contract under test:

- Rollups only consider ``GENERATION`` observations. ``logged_calls`` also
  holds TOOL/CHAIN/structural rows, and the agent-task root span's latency is
  the whole run's wall clock — those must not win "slowest call" or count as
  model time.
- Reasoning reads ``raw_usage["reasoning"]``; a run where no call reported the
  dimension stays ``None`` (unknown, not zero). When only some calls reported,
  the totals are sums over the reporting calls.
- Errored generations are excluded from usage facts (a provider error omits
  the final usage event) but keep their latency — a generation that failed
  after four minutes still spent four minutes in the model.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from apo.metrics.aggregate import calculate_and_store_aggregate_metrics
from apo.models.db import AgentTaskRunDB, LoggedCallDB
from apo.services.trace_backend import NativeTraceBackend

NOW = datetime(2026, 8, 2, tzinfo=timezone.utc)


@pytest.fixture
def session() -> Session:  # pyright: ignore[reportInvalidTypeForm]
    eng = create_engine("sqlite://", poolclass=StaticPool)
    SQLModel.metadata.create_all(eng)
    sess = Session(eng)
    yield sess  # pyright: ignore[reportReturnType]
    sess.close()


def _make_task_run(run_id: str = "tr1", trace_run_id: str = "run-1") -> AgentTaskRunDB:
    return AgentTaskRunDB(
        id=run_id,
        batch_run_id="bch-1",
        task_id="task/x",
        task_path="task/x",
        status="completed",
        trace_run_id=trace_run_id,
    )


def _make_call(
    *,
    cid: str,
    run_id: str = "run-1",
    model: str = "deepseek-v4.1-flash",
    observation_type: str = "GENERATION",
    latency_ms: float | None = None,
    raw_usage: dict[str, int] | None = None,
) -> LoggedCallDB:
    return LoggedCallDB(  # pyright: ignore[reportCallIssue]
        id=cid,
        project="default",
        task_id="task/x",
        run_id=run_id,
        model=model,
        observation_type=observation_type,
        created_at=NOW,
        latency_ms=latency_ms,
        raw_usage=raw_usage,
    )


class TestGenerationOnlyCallSet:
    """Tool and structural observations must not contaminate timing rollups."""

    def test_root_span_and_tool_never_win_slowest_call(self, session: Session) -> None:
        tr = _make_task_run()
        session.add(tr)
        session.add(_make_call(cid="gen-1", latency_ms=30_000.0))
        session.add(_make_call(cid="gen-2", latency_ms=5_000.0))
        # The agent-task root span: latency ≈ the whole run's wall clock.
        session.add(
            _make_call(
                cid="root",
                model="agent-task",
                observation_type="SPAN",
                latency_ms=600_000.0,
            )
        )
        # A tool that ran longer than any model call.
        session.add(
            _make_call(cid="tool-1", observation_type="TOOL", latency_ms=120_000.0)
        )
        session.commit()

        NativeTraceBackend().aggregate_costs(session, tr, "default")

        assert tr.max_call_latency_ms == 30_000.0
        assert tr.max_call_latency_call_id == "gen-1"
        # Model time excludes both the root span and the tool.
        assert tr.total_model_time_ms == 35_000.0

    def test_non_generation_cost_is_not_counted(self, session: Session) -> None:
        tr = _make_task_run()
        session.add(tr)
        session.add(_make_call(cid="gen-1", raw_usage={"reasoning": 500}))
        # A tool row carrying stray usage fields must not flip the totals.
        session.add(
            _make_call(
                cid="tool-1",
                observation_type="TOOL",
                raw_usage={"reasoning": 99_999},
            )
        )
        session.commit()

        NativeTraceBackend().aggregate_costs(session, tr, "default")

        assert tr.total_reasoning_tokens == 500
        assert tr.max_call_reasoning_call_id == "gen-1"


class TestUnknownNotZero:
    """Absence of the reasoning dimension is unknown, never zero."""

    def test_no_call_reports_reasoning(self, session: Session) -> None:
        tr = _make_task_run()
        session.add(tr)
        session.add(_make_call(cid="c1", latency_ms=1_000.0))
        session.add(_make_call(cid="c2", raw_usage={"output": 10}, latency_ms=2_000.0))
        session.commit()

        NativeTraceBackend().aggregate_costs(session, tr, "default")

        assert tr.total_reasoning_tokens is None
        assert tr.max_call_reasoning_tokens is None
        assert tr.max_call_reasoning_call_id is None
        # Latency facts are independent of reasoning reporting.
        assert tr.total_model_time_ms == 3_000.0

    def test_explicit_zero_reasoning_is_known_zero(self, session: Session) -> None:
        tr = _make_task_run()
        session.add(tr)
        session.add(_make_call(cid="c1", raw_usage={"reasoning": 0}))
        session.commit()

        NativeTraceBackend().aggregate_costs(session, tr, "default")

        assert tr.total_reasoning_tokens == 0
        assert tr.max_call_reasoning_tokens == 0
        assert tr.max_call_reasoning_call_id == "c1"

    def test_no_latency_anywhere_leaves_model_time_null(
        self, session: Session
    ) -> None:
        tr = _make_task_run()
        session.add(tr)
        session.add(_make_call(cid="c1", raw_usage={"reasoning": 10}))
        session.commit()

        NativeTraceBackend().aggregate_costs(session, tr, "default")

        assert tr.total_model_time_ms is None
        assert tr.max_call_latency_ms is None


class TestPartialReporting:
    """Mixed reporters sum over the reporting calls only."""

    def test_sum_covers_reporting_calls(self, session: Session) -> None:
        tr = _make_task_run()
        session.add(tr)
        session.add(_make_call(cid="c1", raw_usage={"reasoning": 100}))
        session.add(_make_call(cid="c2", raw_usage={"reasoning": 900}))
        session.add(_make_call(cid="c3", raw_usage={"output": 5}))
        session.commit()

        NativeTraceBackend().aggregate_costs(session, tr, "default")

        assert tr.total_reasoning_tokens == 1000
        assert tr.max_call_reasoning_tokens == 900
        assert tr.max_call_reasoning_call_id == "c2"


class TestErroredGenerationSplit:
    """Usage excludes errored generations; latency keeps them."""

    def test_errored_generation_counts_latency_but_not_reasoning(
        self, session: Session
    ) -> None:
        from apo.models.db import OtlpSpanDB

        tr = _make_task_run()
        session.add(tr)
        # Healthy generation: short, modest reasoning.
        session.add(_make_call(cid="ok-1", latency_ms=2_000.0, raw_usage={"reasoning": 100}))
        # Errored generation: long call whose usage event never arrived.
        session.add(
            _make_call(cid="err-1", latency_ms=240_000.0, raw_usage={"reasoning": 5_000})
        )
        session.add(
            OtlpSpanDB(  # pyright: ignore[reportCallIssue]
                trace_id="run-1",
                span_id="err-1",
                project_id="default",
                span_name="chat",
                status_code=2,
                attributes={"gen_ai.response.finish_reasons": ["error"]},
            )
        )
        session.commit()

        NativeTraceBackend().aggregate_costs(session, tr, "default")

        # Reasoning only counts the healthy call.
        assert tr.total_reasoning_tokens == 100
        assert tr.max_call_reasoning_call_id == "ok-1"
        # Latency keeps the errored call: four minutes in the model is a fact.
        assert tr.max_call_latency_ms == 240_000.0
        assert tr.max_call_latency_call_id == "err-1"
        assert tr.total_model_time_ms == 242_000.0


class TestTraceRunMetricRows:
    """The trace-run ``run_metrics`` rows share the same contract."""

    def test_metric_names_and_generation_filtering(self, session: Session) -> None:
        session.add(_make_call(cid="g1", run_id="tr-run", latency_ms=8_000.0, raw_usage={"reasoning": 42}))
        session.add(
            _make_call(
                cid="root",
                run_id="tr-run",
                model="agent-task",
                observation_type="SPAN",
                latency_ms=900_000.0,
            )
        )
        session.commit()

        rows = calculate_and_store_aggregate_metrics(session, "tr-run", "default")
        by_name = {r.metric_name: r for r in rows}

        assert by_name["max_call_latency_ms"].score == 8_000.0
        assert by_name["max_call_latency_ms"].meta == {"call_id": "g1"}
        assert by_name["total_model_time_ms"].score == 8_000.0
        # avg_latency is a generation-only average: without the filter the
        # 900s root span would drag it to ~454s.
        assert by_name["avg_latency"].score == 8_000.0
        assert by_name["total_reasoning_tokens"].score == 42.0
        assert by_name["max_call_reasoning_tokens"].meta == {"call_id": "g1"}

    def test_no_reasoning_yields_no_reasoning_rows(self, session: Session) -> None:
        session.add(_make_call(cid="g1", run_id="tr-run", latency_ms=1_000.0))
        session.commit()

        rows = calculate_and_store_aggregate_metrics(session, "tr-run", "default")
        names = {r.metric_name for r in rows}

        assert "total_reasoning_tokens" not in names
        assert "max_call_reasoning_tokens" not in names
        assert "max_call_latency_ms" in names
