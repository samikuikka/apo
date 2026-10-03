# pyright: reportAny=false, reportArgumentType=false, reportCallIssue=false, reportDeprecated=false, reportImplicitStringConcatenation=false, reportMissingParameterType=false, reportMissingTypeArgument=false, reportPrivateUsage=false, reportReturnType=false, reportUnannotatedClassAttribute=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

"""Terminal Task Runs adopt traces that drained in after finalization.

A cancelled/failed run's final trace flush can arrive after the failure
submission finalized the run row (local collector, backend outage), and the
collector's API-key auth can never claim at ingest — telemetry attributes are
not authorization. The maintenance adoption pass is the control-plane half:
match ingested ``apo.task.run`` root spans to terminal, trace-less runs.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlmodel import Session, text

from apo.db import engine, reset_apo_file_db
from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB, OtlpSpanDB
from apo.services.retention import adopt_orphan_traces_for_terminal_task_runs


def _seed_terminal_run(session: Session, run_id: str, *, completed: bool = True) -> None:
    old = datetime.now(timezone.utc) - timedelta(days=2)
    batch = AgentTaskBatchRunDB(
        id=f"batch-{run_id}",
        project="p1",
        status="completed",
        selection_type="all",
        created_at=old,
        completed_at=old,
    )
    run = AgentTaskRunDB(
        id=run_id,
        batch_run_id=batch.id,
        task_id="t",
        task_path="t",
        status="error" if completed else "running",
        created_at=old,
        started_at=old,
        # completed_at is the terminal marker adoption keys on.
        completed_at=old if completed else None,
    )
    session.add(batch)
    session.add(run)
    session.commit()


def _seed_root_span(
    session: Session,
    trace_id: str,
    run_id: str,
    *,
    age_days: int = 2,
) -> None:
    old = datetime.now(timezone.utc) - timedelta(days=age_days)
    session.add(
        OtlpSpanDB(
            project_id="p1",
            trace_id=trace_id,
            span_id="0000000000000001",
            parent_span_id=None,
            span_name="apo.task.run",
            start_time=old,
            end_time=old,
            created_at=old,
            attributes={"apo.task.run.id": run_id},
        )
    )
    session.commit()


def setup_module() -> None:
    reset_apo_file_db()


def teardown_module() -> None:
    with Session(engine) as session:
        session.execute(text("DELETE FROM otlp_spans"))
        session.execute(text("DELETE FROM agent_task_runs"))
        session.execute(text("DELETE FROM agent_task_batch_runs"))
        session.commit()


def test_adopts_trace_for_terminal_run(session=None) -> None:
    with Session(engine) as s:
        _seed_terminal_run(s, "run-adopt-1")
        _seed_root_span(s, "trace-adopt-1", "run-adopt-1")

        adopted = adopt_orphan_traces_for_terminal_task_runs(s)

        assert adopted == 1
        run = s.get(AgentTaskRunDB, "run-adopt-1")
        assert run is not None
        assert run.trace_run_id == "trace-adopt-1"


def test_skips_non_terminal_run() -> None:
    with Session(engine) as s:
        _seed_terminal_run(s, "run-adopt-2", completed=False)
        _seed_root_span(s, "trace-adopt-2", "run-adopt-2")

        adopted = adopt_orphan_traces_for_terminal_task_runs(s)

        assert adopted == 0
        run = s.get(AgentTaskRunDB, "run-adopt-2")
        assert run is not None
        assert run.trace_run_id is None


def test_never_steals_a_trace_another_run_owns() -> None:
    with Session(engine) as s:
        _seed_terminal_run(s, "run-adopt-3")
        _seed_terminal_run(s, "run-adopt-4")
        _seed_root_span(s, "trace-adopt-3", "run-adopt-3")
        # run-4 already owns the trace; run-3's maintenance adoption must
        # not reassign it (one-trace invariant).
        owned = s.get(AgentTaskRunDB, "run-adopt-4")
        assert owned is not None
        owned.trace_run_id = "trace-adopt-3"
        s.add(owned)
        s.commit()

        adopted = adopt_orphan_traces_for_terminal_task_runs(s)

        assert adopted == 0
        fresh = s.get(AgentTaskRunDB, "run-adopt-3")
        assert fresh is not None
        assert fresh.trace_run_id is None


def test_adopted_trace_is_not_re_adopted() -> None:
    with Session(engine) as s:
        _seed_terminal_run(s, "run-adopt-5")
        _seed_root_span(s, "trace-adopt-5", "run-adopt-5")
        assert adopt_orphan_traces_for_terminal_task_runs(s) == 1
        # Idempotent: the run now owns its trace; a second pass is a no-op.
        assert adopt_orphan_traces_for_terminal_task_runs(s) == 0
