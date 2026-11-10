"""Query-shape tests for deferred heavy columns on initial-event loads.

SSE opens and summary lists must keep payload columns (transcripts, call
bodies, judgment evidence) out of the heap. The defers that guarantee it
have no behavioral symptom, so the SELECT shape itself is pinned here:
dropping a ``.options(*...)`` tomorrow fails these tests instead of
quietly loading megabytes per request.
"""

import re
from collections.abc import Callable
from datetime import datetime, timezone

from sqlalchemy import event
from sqlmodel import Session

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskJudgmentDB,
    AgentTaskRunDB,
    LoggedCallDB,
    RunDB,
)
from apo.routes.run_events import _build_initial_events as batch_initial_events
from apo.routes.trace_stream import _build_initial_events as trace_initial_events
from apo.services.judgments import list_judgment_rows

NOW = datetime.now(timezone.utc)


def _selects_while(session: Session, fn: Callable[[], object]) -> list[str]:
    statements: list[str] = []

    def _capture(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    engine = session.get_bind()
    event.listen(engine, "before_cursor_execute", _capture)
    try:
        fn()
    finally:
        event.remove(engine, "before_cursor_execute", _capture)
    return [s for s in statements if s.lstrip().upper().startswith("SELECT")]


def test_batch_initial_events_defer_transcripts(session: Session) -> None:
    session.add(
        AgentTaskBatchRunDB(
            id="b1",
            project="p",
            selection_type="manual",
            status="running",
            total_tasks=1,
            created_at=NOW,
        )
    )
    session.add(
        AgentTaskRunDB(
            id="r1",
            batch_run_id="b1",
            task_id="t",
            task_path="t",
            status="running",
            transcript_json={"turns": ["heavy"]},
            started_at=NOW,
        )
    )
    session.commit()

    selects = _selects_while(session, lambda: batch_initial_events("p", session))
    joined = " ".join(selects).lower()
    assert "transcript_json" not in joined, selects


def test_trace_initial_events_defer_call_payloads(session: Session) -> None:
    session.add(RunDB(id="tr1", project="p", task_id="t", created_at=NOW, call_count=1))
    session.add(
        LoggedCallDB(
            row_id=1,
            id="c1",
            run_id="tr1",
            project="p",
            task_id="t",
            model="m1",
            created_at=NOW,
            step_name="step",
            messages=[{"role": "user", "content": "heavy"}],
            input="request body",
            output="response body",
            tool_parameters={"a": 1},
            tool_result={"b": 2},
        )
    )
    session.commit()

    selects = _selects_while(session, lambda: trace_initial_events("tr1", "p", session))
    joined = " ".join(selects).lower()
    for column in (
        "logged_calls.messages",
        "logged_calls.input",
        "logged_calls.output",
        "logged_calls.tool_parameters",
        "logged_calls.tool_result",
        "logged_calls.cost_breakdown",
        "logged_calls.raw_usage",
    ):
        # Word boundary: `output` must not prefix-match output_token_scope.
        assert not re.search(rf"{column}\b", joined), (column, selects)


def test_judgment_list_defers_evidence(session: Session) -> None:
    session.add(
        AgentTaskBatchRunDB(
            id="b1",
            project="p",
            selection_type="manual",
            status="completed",
            total_tasks=1,
            created_at=NOW,
        )
    )
    session.add(
        AgentTaskRunDB(
            id="r1",
            batch_run_id="b1",
            task_id="t",
            task_path="t",
            status="passed",
            pass_result=True,
            started_at=NOW,
            completed_at=NOW,
        )
    )
    # No ORM relationship links the judgment to the run, so the run needs
    # its own commit before the judgment insert (flush order is by table,
    # and agent_task_judgments sorts first).
    session.commit()
    session.add(
        AgentTaskJudgmentDB(
            task_run_id="r1",
            project="p",
            pass_result=True,
            checks_json=[{"check": "heavy"}],
            stability_json=[{"attempt": 1}],
            created_at=NOW,
        )
    )
    session.commit()

    selects = _selects_while(session, lambda: list_judgment_rows(session, "r1"))
    joined = " ".join(selects).lower()
    assert "checks_json" not in joined, selects
    assert "stability_json" not in joined, selects
