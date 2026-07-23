"""Regression guard for the task-list memory blowup (production OOM).

The task list used to load *every* ``AgentTaskRunDB`` row for every task to
compute pass-rate stats. Each row carries multi-MB ``transcript_json`` /
``deliverables_json`` JSON columns that the stats math never reads — so one
page load pulled hundreds of MB into memory and got the backend OOM-killed
(restart + browser "fetch error").

These tests pin the fix: the stats loader must SELECT only the scalar
columns + ``checks_json`` that aggregation needs, and must never fetch the
heavy transcript/deliverables blobs. The SQL is captured via SQLAlchemy's
``before_cursor_execute`` event and asserted on column name — the cheapest,
most direct way to lock "this column is not on the wire".
"""

from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event
from sqlmodel import Session

from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB
from apo.services.agent_task_stats import RunStatFields, load_run_stat_fields

# Reuse the in-memory test engine from conftest so the cursor-event listener
# actually sees the loader's queries.
from tests.conftest import engine

_NOW = datetime(2026, 7, 23, 12, 0, 0, tzinfo=timezone.utc)
_OLDER = _NOW - timedelta(hours=1)


def _batch(batch_id: str, project: str) -> AgentTaskBatchRunDB:
    return AgentTaskBatchRunDB(
        id=batch_id,
        project=project,
        selection_type="task",
        selection_query=None,
        task_root="/tmp/tasks",
        environment="default",
        status="completed",
        total_tasks=1,
        created_at=_NOW,
    )


def _run(
    run_id: str,
    batch_id: str,
    task_id: str,
    *,
    status: str = "passed",
    pass_result: bool | None = True,
    total_cost: float | None = 0.001,
    checks: list[dict[str, object]] | None = None,
    started_at: datetime | None = _NOW,
) -> AgentTaskRunDB:
    # The heavy columns are set deliberately. The whole point of these tests
    # is to prove the stats loader ignores them — so they must be present in
    # the seeded rows (otherwise "not loaded" would be vacuously true).
    return AgentTaskRunDB(
        id=run_id,
        batch_run_id=batch_id,
        task_id=task_id,
        task_path=f"/tmp/tasks/{task_id}",
        status=status,
        pass_result=pass_result,
        started_at=started_at,
        completed_at=started_at,
        total_cost=total_cost,
        checks_json=checks,
        transcript_json={"messages": ["x" * 100_000]},  # large, must stay on disk
        deliverables_json={"artifacts": ["y" * 50_000]},  # large, must stay on disk
    )


@pytest.fixture
def captured_sql() -> Iterator[list[str]]:
    """Record every SQL statement run on the test engine during the test.

    Untyped SQLAlchemy event-listener params mirror ``conftest.py``'s
    ``_enable_foreign_keys`` listener — the callback signature is fixed by
    SQLAlchemy's ``before_cursor_execute`` event and isn't worth the ``Any``
    noise of spelling it out.
    """
    statements: list[str] = []

    def _capture(
        _conn: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: object,
    ) -> None:
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", _capture)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", _capture)


def test_stats_loader_does_not_fetch_transcript_or_deliverables(
    session: Session,
    captured_sql: list[str],
) -> None:
    session.add_all([_batch("batch-1", "project-1")])
    session.add_all(
        [
            _run("run-a1", "batch-1", "task-a", checks=[{"pass": True}]),
            _run("run-a2", "batch-1", "task-a", status="failed", pass_result=False),
            _run("run-b1", "batch-1", "task-b", status="failed", pass_result=False),
        ]
    )
    session.commit()

    loaded = load_run_stat_fields(session, "project-1", ["task-a", "task-b"])
    assert loaded  # sanity: the loader returned grouped data

    # Only inspect SELECTs against agent_task_runs — the seeded INSERTs
    # legitimately write transcript_json (that's the test data), and the
    # invariant is about *reading* it for stats, not storing it.
    task_run_selects = [
        s for s in captured_sql
        if s.lower().startswith("select") and "agent_task_runs" in s
    ]
    assert task_run_selects, "expected the loader to query agent_task_runs"

    for sql in task_run_selects:
        lowered = sql.lower()
        assert "transcript_json" not in lowered, (
            "stats loader must not SELECT transcript_json — it can be MBs per "
            f"row and caused production OOM. Offending SQL:\n{sql}"
        )
        assert "deliverables_json" not in lowered, (
            "stats loader must not SELECT deliverables_json for the same reason. "
            f"Offending SQL:\n{sql}"
        )


def test_stats_loader_returns_correct_grouped_fields(session: Session) -> None:
    session.add_all([_batch("batch-1", "project-1"), _batch("batch-2", "project-2")])
    session.add_all(
        [
            _run(
                "run-a1",
                "batch-1",
                "task-a",
                status="passed",
                pass_result=True,
                total_cost=0.002,
                checks=[{"pass": True}, {"pass": False}],
                started_at=_NOW,
            ),
            _run(
                "run-a2",
                "batch-1",
                "task-a",
                status="failed",
                pass_result=False,
                total_cost=0.004,
                started_at=_OLDER,
            ),
            # Different project's batch — must be excluded by the project filter.
            _run("run-c1", "batch-2", "task-a", status="passed", pass_result=True),
        ]
    )
    session.commit()

    grouped = load_run_stat_fields(session, "project-1", ["task-a"])

    assert set(grouped.keys()) == {"task-a"}
    runs = grouped["task-a"]
    assert len(runs) == 2
    assert all(isinstance(r, RunStatFields) for r in runs)

    # Descending started_at: run-a1 (newer) first, run-a2 (older) second.
    assert runs[0].started_at == _NOW
    assert runs[0].status == "passed"
    assert runs[0].pass_result is True
    assert runs[0].total_cost == 0.002
    assert runs[0].checks_json == [{"pass": True}, {"pass": False}]
    assert runs[1].started_at == _OLDER
    assert runs[1].status == "failed"


def test_stats_loader_excludes_other_projects(session: Session) -> None:
    session.add_all([_batch("b-p1", "project-1"), _batch("b-p2", "project-2")])
    session.add_all(
        [
            _run("r1", "b-p1", "shared-task", status="passed", pass_result=True),
            _run("r2", "b-p2", "shared-task", status="failed", pass_result=False),
        ]
    )
    session.commit()

    grouped = load_run_stat_fields(session, "project-1", ["shared-task"])
    assert len(grouped["shared-task"]) == 1


def test_stats_loader_empty_task_ids_returns_empty(session: Session) -> None:
    assert load_run_stat_fields(session, "project-1", []) == {}
