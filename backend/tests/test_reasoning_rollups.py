"""Issue #309: run-level reasoning and per-call timing rollups.

A run's summary must show that a model's reasoning changed shape without
opening traces call by call: total/max reasoning tokens, the slowest single
call, and total model wall time. Unknown reasoning (provider never reported
the dimension) must stay null/absent — never render as zero.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from apo.metrics.aggregate import (
    calculate_and_store_aggregate_metrics,
    compute_call_aggregates,
)
from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB, LoggedCallDB
from apo.routes.runs.metrics import calculate_run_metrics_from_calls

NOW = datetime(2026, 9, 22, tzinfo=timezone.utc)
TRACE_ID = "30930930930930930930930930930930"


@pytest.fixture
def session() -> Session:  # pyright: ignore[reportInvalidTypeForm]
    engine = create_engine("sqlite://", poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    value = Session(engine)
    yield value  # pyright: ignore[reportReturnType]
    value.close()


def _call(
    *,
    cid: str,
    run_id: str = "run-1",
    latency_ms: float | None = None,
    reasoning: int | None = None,
    raw_usage: dict[str, int] | None = None,
    prompt_tokens: int | None = None,
    completion_tokens: int | None = None,
    observation_type: str = "GENERATION",
) -> LoggedCallDB:
    usage = dict(raw_usage or {})
    if reasoning is not None and "reasoning" not in usage:
        usage["reasoning"] = reasoning
    return LoggedCallDB(  # pyright: ignore[reportCallIssue]
        id=cid,
        project="default",
        task_id="task/x",
        run_id=run_id,
        model="deepseek-v4.1-flash",
        observation_type=observation_type,
        created_at=NOW,
        latency_ms=latency_ms,
        cost=1_000,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        raw_usage=usage or None,
    )


class TestComputeCallAggregates:
    """The pure computation both persistence paths share."""

    def test_reasoning_total_and_max_with_call_reference(self) -> None:
        aggregates = {
            agg.metric_name: agg
            for agg in compute_call_aggregates([
                _call(cid="a", reasoning=1_000),
                _call(cid="b", reasoning=12_000),
                _call(cid="c", reasoning=3_000),
            ])
        }

        assert aggregates["total_reasoning_tokens"].score == 16_000
        deepest = aggregates["max_call_reasoning_tokens"]
        assert deepest.score == 12_000
        # The UI links "max" straight to the winning observation.
        assert deepest.meta == {"call_id": "b"}

    def test_no_reporting_call_leaves_reasoning_absent_not_zero(self) -> None:
        # raw_usage without a "reasoning" key: the provider never reported
        # the dimension. Unknown, not zero — no metric rows at all.
        aggregates = compute_call_aggregates([
            _call(cid="a", raw_usage={"input": 100, "output": 50}),
        ])
        names = {agg.metric_name for agg in aggregates}
        assert "total_reasoning_tokens" not in names
        assert "max_call_reasoning_tokens" not in names

    def test_reported_zero_is_known_zero(self) -> None:
        # A provider that reports reasoning=0 thought measurably-zero —
        # the metrics exist and carry 0, distinct from absent.
        aggregates = {
            agg.metric_name: agg
            for agg in compute_call_aggregates([_call(cid="a", reasoning=0)])
        }
        assert aggregates["total_reasoning_tokens"].score == 0
        assert aggregates["max_call_reasoning_tokens"].score == 0

    def test_mixed_reporting_totals_are_partial_and_say_so(self) -> None:
        aggregates = {
            agg.metric_name: agg
            for agg in compute_call_aggregates([
                _call(cid="a", reasoning=500),
                _call(cid="b", raw_usage={"input": 10, "output": 5}),
            ])
        }
        total = aggregates["total_reasoning_tokens"]
        assert total.score == 500
        assert "did not report" in total.reasoning

    def test_latency_extremes_and_model_time(self) -> None:
        aggregates = {
            agg.metric_name: agg
            for agg in compute_call_aggregates([
                _call(cid="a", latency_ms=1_000.0),
                _call(cid="b", latency_ms=252_000.0),
                _call(cid="c", latency_ms=4_000.0),
            ])
        }
        slowest = aggregates["max_call_latency_ms"]
        assert slowest.score == 252_000.0
        assert slowest.meta == {"call_id": "b"}
        # Model wall time sums every call latency — the "one call thought for
        # four minutes" number the average hides.
        assert aggregates["total_model_time_ms"].score == 257_000.0

    def test_tool_and_root_spans_never_win_timing(self) -> None:
        # The agent-task root span's latency is the run's whole wall clock;
        # a tool call is not a model call. Neither may win "slowest call"
        # or inflate model time (issue #309).
        aggregates = {
            agg.metric_name: agg
            for agg in compute_call_aggregates([
                _call(cid="gen", latency_ms=4_000.0),
                _call(cid="tool", latency_ms=120_000.0, observation_type="TOOL"),
                _call(cid="root", latency_ms=600_000.0, observation_type="CHAIN"),
            ])
        }
        assert aggregates["max_call_latency_ms"].score == 4_000.0
        assert aggregates["max_call_latency_ms"].meta == {"call_id": "gen"}
        assert aggregates["total_model_time_ms"].score == 4_000.0

    def test_legacy_metrics_still_present(self) -> None:
        aggregates = {
            agg.metric_name: agg
            for agg in compute_call_aggregates([
                _call(cid="a", latency_ms=1_000.0, prompt_tokens=100, completion_tokens=20),
            ])
        }
        assert aggregates["total_cost"].score == 1_000
        assert aggregates["avg_latency"].score == 1_000.0
        assert aggregates["total_tokens"].score == 120


class TestBothPersistenceTwins:
    """Stored and on-read rows carry the same new metrics, meta included."""

    def test_stored_rows_carry_meta(self, session: Session) -> None:
        session.add(_call(cid="a", reasoning=2_000, latency_ms=5_000.0))
        session.commit()

        rows = calculate_and_store_aggregate_metrics(session, "run-1", "default")
        by_name = {r.metric_name: r for r in rows}
        assert by_name["max_call_reasoning_tokens"].meta == {"call_id": "a"}
        assert by_name["max_call_latency_ms"].meta == {"call_id": "a"}
        assert by_name["total_reasoning_tokens"].score == 2_000
        assert by_name["total_model_time_ms"].score == 5_000.0

    def test_derived_rows_match_stored_rows(self, session: Session) -> None:
        calls = [
            _call(cid="a", reasoning=100, latency_ms=1_000.0, prompt_tokens=5, completion_tokens=5),
            _call(cid="b", reasoning=900, latency_ms=9_000.0, prompt_tokens=45, completion_tokens=45),
        ]
        derived = {
            r.metric_name: r.score
            for r in calculate_run_metrics_from_calls(calls, "run-1")
        }
        assert derived["total_reasoning_tokens"] == 1_000
        assert derived["max_call_reasoning_tokens"] == 900
        assert derived["max_call_latency_ms"] == 9_000.0
        assert derived["total_model_time_ms"] == 10_000.0


class TestV46Migration:
    """The schema migration adds the columns and backfills terminal runs."""

    _NEW_COLUMNS = (
        "total_reasoning_tokens",
        "max_call_reasoning_tokens",
        "max_call_reasoning_call_id",
        "max_call_latency_ms",
        "max_call_latency_call_id",
        "total_model_time_ms",
    )

    def test_backfills_terminal_runs_skips_live_runs(self, monkeypatch) -> None:
        import apo.db

        engine = create_engine("sqlite://", poolclass=StaticPool)
        SQLModel.metadata.create_all(engine)
        # Regress to the pre-v46 shape: drop the new columns so the
        # migration's add+backfill path runs instead of no-op'ing.
        with engine.begin() as conn:
            for column in self._NEW_COLUMNS:
                conn.exec_driver_sql(
                    f"ALTER TABLE agent_task_runs DROP COLUMN {column}"
                )

        with Session(engine) as session:
            session.add(AgentTaskBatchRunDB(  # pyright: ignore[reportCallIssue]
                id="bch-1", project="default", selection_type="manual", status="completed"
            ))
            session.add(_call(cid="a", run_id=TRACE_ID, reasoning=2_000, latency_ms=8_000.0))
            session.commit()
        # Task-run rows go in as raw SQL: the ORM's INSERT still names the
        # dropped columns, which is exactly the pre-v46 shape under test.
        # 'tr-dangling' carries recorded totals but no surviving trace rows —
        # retention can leave exactly this shape, and a schema migration
        # must not wipe the recorded aggregates while backfilling.
        with engine.begin() as conn:
            conn.exec_driver_sql(
                "INSERT INTO agent_task_runs "
                "(id, batch_run_id, task_id, task_path, sequence_index, status, trace_run_id, "
                " trace_persistence_status, total_checks, passed_checks, failed_checks, "
                " unpriced_call_count, corrected_tests, total_cost, total_tokens) "
                "VALUES ('tr-terminal', 'bch-1', 'task/x', 'task/x', 0, 'passed', :trace, "
                " 'pending', 0, 0, 0, 0, 0, NULL, NULL), "
                "('tr-live', 'bch-1', 'task/y', 'task/y', 0, 'running', 'trace-live', "
                " 'pending', 0, 0, 0, 0, 0, NULL, NULL), "
                "('tr-dangling', 'bch-1', 'task/z', 'task/z', 0, 'passed', 'trace-gone', "
                " 'pending', 1, 1, 0, 0, 0, 1234.5, 700)",
                {"trace": TRACE_ID},
            )

        monkeypatch.setattr(apo.db, "engine", engine)
        apo.db._migrate_to_v47()

        with Session(engine) as session:
            done = session.get(AgentTaskRunDB, "tr-terminal")
            assert done is not None
            assert done.total_reasoning_tokens == 2_000
            assert done.max_call_reasoning_call_id == "a"
            assert done.max_call_latency_ms == 8_000.0
            assert done.total_model_time_ms == 8_000.0
            # A live run is never written by a migration racing the runner.
            running = session.get(AgentTaskRunDB, "tr-live")
            assert running is not None
            assert running.total_reasoning_tokens is None
            # Recorded historical totals survive untouched; the run has no
            # generation facts, so its rollups honestly stay null.
            dangling = session.get(AgentTaskRunDB, "tr-dangling")
            assert dangling is not None
            assert dangling.total_cost == 1234.5
            assert dangling.total_tokens == 700
            assert dangling.total_reasoning_tokens is None
            assert dangling.total_model_time_ms is None

    def test_backfill_resumes_after_a_crash_between_ddl_and_completion(
        self, monkeypatch
    ) -> None:
        """A kill mid-backfill leaves the columns present but the version
        unstamped; re-running must still process the unbackfilled runs
        instead of early-returning on "columns exist"."""
        import apo.db

        engine = create_engine("sqlite://", poolclass=StaticPool)
        SQLModel.metadata.create_all(engine)
        # Crash simulation: the DDL landed (columns exist) but the backfill
        # never ran. Drop + re-add the columns to reach that state exactly.
        with engine.begin() as conn:
            for column in self._NEW_COLUMNS:
                conn.exec_driver_sql(
                    f"ALTER TABLE agent_task_runs DROP COLUMN {column}"
                )
            for column, kind in (
                ("total_reasoning_tokens", "INTEGER"),
                ("max_call_reasoning_tokens", "INTEGER"),
                ("max_call_reasoning_call_id", "VARCHAR"),
                ("max_call_latency_ms", "FLOAT"),
                ("max_call_latency_call_id", "VARCHAR"),
                ("total_model_time_ms", "FLOAT"),
            ):
                conn.exec_driver_sql(
                    f"ALTER TABLE agent_task_runs ADD COLUMN {column} {kind}"
                )

        with Session(engine) as session:
            session.add(AgentTaskBatchRunDB(  # pyright: ignore[reportCallIssue]
                id="bch-1", project="default", selection_type="manual", status="completed"
            ))
            session.add(_call(cid="a", run_id=TRACE_ID, reasoning=500, latency_ms=3_000.0))
            session.commit()
        with engine.begin() as conn:
            conn.exec_driver_sql(
                "INSERT INTO agent_task_runs "
                "(id, batch_run_id, task_id, task_path, sequence_index, status, trace_run_id, "
                " trace_persistence_status, total_checks, passed_checks, failed_checks, "
                " unpriced_call_count, corrected_tests) "
                "VALUES ('tr-1', 'bch-1', 'task/x', 'task/x', 0, 'passed', :trace, "
                " 'pending', 0, 0, 0, 0, 0)",
                {"trace": TRACE_ID},
            )

        monkeypatch.setattr(apo.db, "engine", engine)
        apo.db._migrate_to_v47()

        with Session(engine) as session:
            run = session.get(AgentTaskRunDB, "tr-1")
            assert run is not None
            assert run.total_reasoning_tokens == 500
            assert run.total_model_time_ms == 3_000.0

        # A later boot with everything backfilled re-examines only the
        # genuinely all-null runs (cheap no-ops) and changes nothing.
        apo.db._migrate_to_v47()
        with Session(engine) as session:
            run = session.get(AgentTaskRunDB, "tr-1")
            assert run is not None
            assert run.total_reasoning_tokens == 500
