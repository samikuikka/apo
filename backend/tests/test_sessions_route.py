# pyright: reportAny=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

from datetime import datetime, timedelta, timezone
from typing import cast

from fastapi import Request
from sqlmodel import Session

from types import SimpleNamespace

from apo.models import LoggedCallDB, RunDB
from apo.routes.runs.sessions import list_sessions

# Direct calls bypass FastAPI's Request injection; a request with no user_id on
# its state takes the dev/open-mode permissive path (pre-enforcement behavior).
_REQ = cast(Request, cast(object, SimpleNamespace(state=SimpleNamespace())))


def _run(session: Session, run_id: str, session_id: str | None, created_at: datetime) -> None:
    session.add(RunDB(id=run_id, project="p", session_id=session_id, created_at=created_at))


def _call(session: Session, call_id: str, run_id: str, cost: int, tokens: int) -> None:
    session.add(
        LoggedCallDB(
            id=call_id,
            project="p",
            run_id=run_id,
            task_id="",
            created_at=datetime.now(timezone.utc),
            model="claude-opus-5",
            cost=cost,
            total_tokens=tokens,
            input={},
            messages=[],
            output={},
        )
    )


def test_aggregates_cost_and_tokens_from_calls(session: Session):
    """Cost/tokens live on logged_calls; runs has no such columns (the query
    used to reference them and 500'd)."""
    now = datetime.now(timezone.utc)
    _run(session, "r1", "s1", now - timedelta(minutes=2))
    _run(session, "r2", "s1", now - timedelta(minutes=1))
    _call(session, "c1", "r1", cost=208_741, tokens=33_387)
    _call(session, "c2", "r1", cost=19_307, tokens=33_614)
    _call(session, "c3", "r2", cost=101_572, tokens=47_106)
    session.commit()

    result = list_sessions(_REQ, project="p", page=0, page_size=20, session=session)

    assert result.total_count == 1
    (row,) = result.data
    assert row.session_id == "s1"
    # trace_count counts runs, not the joined calls.
    assert row.trace_count == 2
    assert row.total_cost == 329_620  # micro-USD
    assert row.total_tokens == 114_107


def test_run_without_calls_reports_zero(session: Session):
    now = datetime.now(timezone.utc)
    _run(session, "r1", "s1", now)
    session.commit()

    (row,) = list_sessions(_REQ, project="p", page=0, page_size=20, session=session).data

    assert row.trace_count == 1
    assert row.total_cost == 0
    assert row.total_tokens == 0


def test_scopes_to_the_requested_project(session: Session):
    now = datetime.now(timezone.utc)
    _run(session, "r1", "s1", now)
    session.add(RunDB(id="r2", project="other", session_id="s2", created_at=now))
    session.commit()

    result = list_sessions(_REQ, project="p", page=0, page_size=20, session=session)

    assert [row.session_id for row in result.data] == ["s1"]


def test_counts_runs_with_no_session_id(session: Session):
    """Runs without a session are reported as the "(none)" group, so they have to
    be counted too — COUNT(DISTINCT session_id) skipped them."""
    now = datetime.now(timezone.utc)
    _run(session, "r1", None, now)
    _run(session, "r2", None, now - timedelta(minutes=1))
    _run(session, "r3", "s1", now - timedelta(minutes=2))
    session.commit()

    result = list_sessions(_REQ, project="p", page=0, page_size=20, session=session)

    assert result.total_count == 2  # the "(none)" group + "s1"
    assert result.total_pages == 1
    assert sorted(row.session_id for row in result.data) == ["(none)", "s1"]
    assert next(r.trace_count for r in result.data if r.session_id == "(none)") == 2


def test_calls_subquery_is_project_scoped_in_the_query_plan(session: Session):
    """G4 (issue #230): the logged_calls aggregation subquery must carry the
    project predicate so SQLite drives it off the project index — without
    it, every sessions page view scans the whole installation's calls."""
    from sqlalchemy import event

    now = datetime.now(timezone.utc)
    _run(session, "r1", "s1", now)
    _call(session, "c1", "r1", cost=1, tokens=1)
    session.commit()

    captured: list[tuple[str, object]] = []

    def _capture(conn, cursor, statement, parameters, context, executemany):  # pyright: ignore[reportUnusedParameter]
        if "FROM logged_calls" in statement:
            captured.append((statement, parameters))

    event.listen(session.bind, "before_cursor_execute", _capture)
    try:
        _ = list_sessions(_REQ, project="p", page=0, page_size=20, session=session)
    finally:
        event.remove(session.bind, "before_cursor_execute", _capture)

    assert captured, "sessions query with the logged_calls subquery never executed"
    statement, bound_params = captured[0]

    # The statement arrives dialect-compiled (qmark placeholders) with its
    # parameter sequence — replay both verbatim under EXPLAIN.
    params_arg = (
        bound_params
        if isinstance(bound_params, dict)
        else cast("tuple[object, ...]", bound_params)
    )
    plan = session.connection().exec_driver_sql(
        "EXPLAIN QUERY PLAN " + statement,
        params_arg,
    ).fetchall()
    plan_text = " | ".join(str(row[3]) for row in plan)

    assert "SCAN logged_calls" not in plan_text, (
        f"logged_calls subquery is not project-scoped — full scan per view: {plan_text}"
    )
    # The subquery must actually filter by project inside, not outside
    # (placeholder style is dialect-compiled — assert the bare predicate).
    assert "logged_calls l WHERE l.project" in statement
