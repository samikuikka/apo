# pyright: reportAny=false, reportAttributeAccessIssue=false, reportCallIssue=false, reportExplicitAny=false, reportImplicitStringConcatenation=false, reportMissingParameterType=false, reportOptionalMemberAccess=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUntypedFunctionDecorator=false, reportUnusedCallResult=false

"""The traces list and its facets read only the requesting project's calls.

``logged_calls`` is one table for every tenant, and trace ids are not unique
across projects (a demo copy shares its ids with the original). So a filter
or facet that reaches into the table by run id alone does two wrong things at
once: it walks other tenants' rows, and it lets another project's copy of a
trace decide this project's answer. These tests pin both halves: the answer
(a shared trace id never crosses projects) and the access path (no statement
touches ``logged_calls`` without a project or run-id constraint).

The plan checks assert shape, never cost: none of the SQLite builds in play
keeps per-value statistics, so the planner cannot tell a small project from a
large one and a step-count threshold would only measure the fixture.
"""

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlmodel import Session

from apo.models import LoggedCallDB, RunDB, RunMetricDB
from apo.routes.runs.list_query import (
    RunListFilters,
    RunListPagination,
    list_run_summaries,
)

BASE = datetime(2026, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
BIG = "big"
SMALL = "small"
# One trace id present in both projects, the way a demo copy shares its ids.
SHARED = "shared-trace"

# The composite indexes the schema declares for these subqueries. Creating
# them here (IF NOT EXISTS) checks the plan under both schemas: the one a
# database has before they exist and the one it has after.
_COMPOSITE_INDEXES = (
    "CREATE INDEX IF NOT EXISTS ix_logged_calls_project_level_run_id "
    "ON logged_calls(project, level, run_id)",
    "CREATE INDEX IF NOT EXISTS ix_logged_calls_project_model_run_id "
    "ON logged_calls(project, model, run_id)",
    "CREATE INDEX IF NOT EXISTS ix_logged_calls_run_project_route_provider "
    "ON logged_calls(run_id, project, route, provider)",
)

Statement = tuple[str, Any]


def _run(
    run_id: str,
    project: str,
    *,
    call_count: int,
    minutes: int = 0,
    environment: str = "prod",
    primary_model: str | None = None,
) -> RunDB:
    return RunDB(
        id=run_id,
        project=project,
        task_id="t",
        call_count=call_count,
        environment=environment,
        primary_model=primary_model,
        created_at=BASE - timedelta(minutes=minutes),
    )


def _call(
    call_id: str,
    run_id: str | None,
    project: str,
    *,
    level: str = "DEFAULT",
    model: str = "m-shared",
    provider: str | None = None,
) -> LoggedCallDB:
    return LoggedCallDB(
        id=call_id,
        project=project,
        task_id="t",
        run_id=run_id,
        model=model,
        provider=provider,
        level=level,
        created_at=BASE,
        input={},
        messages=[],
        output={},
    )


def seed_two_projects(session: Session, *, big_runs: int = 30) -> None:
    """A large project, a small one, and one trace id that lives in both.

    The shared id is the interesting row: its ``big`` copy errored on a model
    only ``big`` uses, while its ``small`` copy is a clean success.
    """
    for index in range(big_runs):
        run_id = f"big-{index}"
        session.add(_run(run_id, BIG, call_count=3, minutes=index, environment="big-env"))
        for call in range(3):
            level = "ERROR" if index % 5 == 0 and call == 0 else "DEFAULT"
            session.add(
                _call(
                    f"{run_id}-c{call}",
                    run_id,
                    BIG,
                    level=level,
                    model="m-big-only",
                    provider="big-host",
                )
            )

    session.add(_run("s-ok", SMALL, call_count=2, minutes=1))
    session.add(_call("s-ok-c0", "s-ok", SMALL, provider="small-host"))
    session.add(_call("s-ok-c1", "s-ok", SMALL))
    session.add(_run("s-warn", SMALL, call_count=2, minutes=2))
    session.add(_call("s-warn-c0", "s-warn", SMALL, level="WARNING"))
    session.add(_call("s-warn-c1", "s-warn", SMALL))
    session.add(_run("s-err", SMALL, call_count=2, minutes=3))
    session.add(_call("s-err-c0", "s-err", SMALL, level="ERROR"))
    session.add(_call("s-err-c1", "s-err", SMALL, level="WARNING"))
    session.add(_run("s-empty", SMALL, call_count=0, minutes=4))

    session.add(_run(SHARED, SMALL, call_count=1, minutes=5))
    session.add(_call("shared-small-c0", SHARED, SMALL))
    session.add(_run(SHARED, BIG, call_count=1, minutes=5, environment="big-env"))
    session.add(
        _call(
            "shared-big-c0",
            SHARED,
            BIG,
            level="ERROR",
            model="m-big-only",
            provider="big-host",
        )
    )
    session.add(
        RunMetricDB(
            run_id=SHARED,
            project=BIG,
            metric_name="big-only-metric",
            metric_type="quality",
            data_type="NUMERIC",
            score=1.0,
            created_at=BASE,
        )
    )
    session.commit()


def _list(session: Session, **filters: Any) -> list[tuple[str, str]]:
    page = list_run_summaries(
        session,
        RunListFilters(**filters),
        RunListPagination(page=0, page_size=100, sort_by=None, sort_order="asc"),
    )
    assert page.total_count == len(page.data)
    return sorted((run.id, run.project) for run in page.data)


def _ids(session: Session, **filters: Any) -> list[str]:
    return [run_id for run_id, _ in _list(session, **filters)]


@contextmanager
def captured_statements(session: Session) -> Iterator[list[Statement]]:
    """Every statement the engine executes inside the block, with its params."""
    engine = session.get_bind()
    statements: list[Statement] = []

    def _capture(_conn, _cursor, statement, parameters, _context, _executemany) -> None:
        statements.append((statement, parameters))

    event.listen(engine, "before_cursor_execute", _capture)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", _capture)


def call_table_plan(session: Session, statements: list[Statement]) -> list[str]:
    """EXPLAIN QUERY PLAN lines that touch ``logged_calls``, for the reads."""
    lines: list[str] = []
    connection = session.connection()
    for statement, parameters in statements:
        if "logged_calls" not in statement:
            continue
        if not statement.lstrip().upper().startswith(("SELECT", "WITH")):
            continue
        rows = connection.exec_driver_sql("EXPLAIN QUERY PLAN " + statement, parameters)
        lines.extend(str(row[3]) for row in rows if "logged_calls" in str(row[3]))
    return lines


def unscoped_call_access(plan: list[str]) -> list[str]:
    """Plan lines that reach ``logged_calls`` with no project or run-id key.

    A ``SCAN`` walks the whole table (or a whole index) for every tenant. A
    ``SEARCH`` is fine only when its seek starts at ``project``, at one run
    id, or at one row.
    """
    scoped_seeks = ("(project=?", "(run_id=?", "(rowid=?")
    return [
        line
        for line in plan
        if line.startswith("SCAN") or not any(seek in line for seek in scoped_seeks)
    ]


STATUS_SETS = [
    ["error"],
    ["warning"],
    ["success"],
    ["error", "warning"],
    ["warning", "success"],
    ["error", "warning", "success"],
]


# ---------------------------------------------------------------------------
# The answer: a shared trace id never crosses projects
# ---------------------------------------------------------------------------


def test_status_filter_judges_a_run_by_its_own_projects_calls(session: Session) -> None:
    seed_two_projects(session)

    # The shared id errored in big only. In small it is a clean success.
    assert _ids(session, project=SMALL, status_values=["error"]) == ["s-err"]
    assert _ids(session, project=SMALL, status_values=["warning"]) == ["s-warn"]
    assert _ids(session, project=SMALL, status_values=["success"]) == ["s-ok", SHARED]
    assert _ids(session, project=SMALL, status_values=["error", "warning", "success"]) == [
        "s-err",
        "s-ok",
        "s-warn",
        SHARED,
    ]


def test_status_filter_agrees_with_the_status_each_row_reports(session: Session) -> None:
    # The filter and the row's own status come from different queries; a run
    # listed under "error" must say "error".
    seed_two_projects(session)

    for status in ("error", "warning", "success"):
        page = list_run_summaries(
            session,
            RunListFilters(project=SMALL, status_values=[status]),
            RunListPagination(page=0, page_size=100, sort_by=None, sort_order="asc"),
        )
        assert page.data, status
        assert {run.status for run in page.data} == {status}


def test_model_filter_matches_only_the_projects_own_calls(session: Session) -> None:
    seed_two_projects(session)

    # Only big's copy of the shared id called this model.
    assert _ids(session, project=SMALL, models=["m-big-only"]) == []
    assert _ids(session, project=SMALL, models=["m-shared"]) == [
        "s-err",
        "s-ok",
        "s-warn",
        SHARED,
    ]


def test_metric_filter_matches_only_the_projects_own_metrics(session: Session) -> None:
    seed_two_projects(session)

    assert _ids(session, project=SMALL, metric_name="big-only-metric") == []
    assert _list(session, project=BIG, metric_name="big-only-metric") == [(SHARED, BIG)]


def test_membership_scope_without_a_pinned_project_reads_the_same(session: Session) -> None:
    seed_two_projects(session)

    assert _ids(session, allowed_projects=[SMALL], status_values=["error"]) == ["s-err"]
    assert _ids(session, allowed_projects=[SMALL], status_values=["success"]) == [
        "s-ok",
        SHARED,
    ]
    assert _ids(session, allowed_projects=[SMALL], models=["m-big-only"]) == []
    assert _ids(session, allowed_projects=[], status_values=["error"]) == []


def test_each_copy_of_a_shared_id_keeps_its_own_status(session: Session) -> None:
    seed_two_projects(session)
    both = [BIG, SMALL]

    errored = _list(session, allowed_projects=both, status_values=["error"])
    succeeded = _list(session, allowed_projects=both, status_values=["success"])

    assert (SHARED, BIG) in errored
    assert (SHARED, SMALL) not in errored
    assert (SHARED, SMALL) in succeeded
    assert (SHARED, BIG) not in succeeded


def test_open_mode_without_any_scope_still_pairs_calls_with_their_project(
    session: Session,
) -> None:
    # Dev/open mode has no project and no membership list. It reads every
    # project by design, but a call still belongs to one run, not to its id.
    seed_two_projects(session)

    errored = _list(session, status_values=["error"])

    assert (SHARED, BIG) in errored
    assert (SHARED, SMALL) not in errored


def test_a_call_without_a_run_does_not_empty_the_negative_filters(session: Session) -> None:
    # NOT IN against a list holding NULL is never true, so one orphan issue
    # call would hide every successful run in the installation.
    seed_two_projects(session)
    session.add(_call("orphan-error", None, SMALL, level="ERROR"))
    session.add(_call("orphan-warning", None, BIG, level="WARNING"))
    session.commit()

    assert _ids(session, project=SMALL, status_values=["success"]) == ["s-ok", SHARED]
    assert _ids(session, project=SMALL, status_values=["warning"]) == ["s-warn"]


def test_facets_count_only_the_requesting_projects_rows(
    client: TestClient, session: Session
) -> None:
    seed_two_projects(session)

    facets = client.get("/v1/runs/facets", params={"project": SMALL}).json()

    def buckets(name: str) -> dict[str, int]:
        return {bucket["value"]: bucket["count"] for bucket in facets[name]}

    # big's copy of the shared id carries an ERROR call, another model, another
    # host, another environment, and a metric. None of it is small's.
    assert buckets("status") == {"success": 2, "warning": 1, "error": 1}
    assert buckets("models") == {"m-shared": 4}
    assert buckets("providers") == {"small-host": 1}
    assert buckets("environments") == {"prod": 5}
    assert buckets("scores") == {}


def test_facets_respect_the_membership_scope(
    make_authed_client: Callable[..., TestClient], session: Session
) -> None:
    from tests.test_run_facets_golden import MEMBER_ID
    from apo.models.db import ProjectDB, ProjectMembershipDB, UserDB

    seed_two_projects(session)
    session.add(UserDB(id=MEMBER_ID, email="m@t.co", name=MEMBER_ID, password_hash="x"))
    session.commit()
    for project in (BIG, SMALL):
        session.add(ProjectDB(id=project, name=project, created_by=MEMBER_ID))
    session.commit()
    session.add(ProjectMembershipDB(project_id=SMALL, user_id=MEMBER_ID, role="owner"))
    session.commit()
    member = make_authed_client(MEMBER_ID, session, is_admin=False)

    facets = member.get("/v1/runs/facets").json()

    assert {b["value"]: b["count"] for b in facets["models"]} == {"m-shared": 4}
    assert {b["value"]: b["count"] for b in facets["environments"]} == {"prod": 5}
    assert facets["scores"] == []


# ---------------------------------------------------------------------------
# The access path: no statement reaches logged_calls without a scope
# ---------------------------------------------------------------------------


@pytest.fixture(params=["declared-indexes", "composite-indexes"])
def schema(request: pytest.FixtureRequest, session: Session) -> str:
    """Run a plan check under the declared schema and with the composites."""
    if request.param == "composite-indexes":
        for ddl in _COMPOSITE_INDEXES:
            session.connection().exec_driver_sql(ddl)
        session.commit()
    return str(request.param)


@pytest.mark.parametrize("statuses", STATUS_SETS, ids=lambda s: "+".join(s))
@pytest.mark.usefixtures("schema")
def test_status_filter_never_reads_calls_outside_the_project(
    statuses: list[str], session: Session
) -> None:
    seed_two_projects(session)

    with captured_statements(session) as statements:
        _ids(session, project=SMALL, status_values=statuses)

    plan = call_table_plan(session, statements)
    assert plan, "the status filter is expected to consult logged_calls"
    assert unscoped_call_access(plan) == []


@pytest.mark.usefixtures("schema")
def test_model_filter_never_reads_calls_outside_the_project(
    session: Session,
) -> None:
    seed_two_projects(session)

    with captured_statements(session) as statements:
        _ids(session, project=SMALL, models=["m-shared"])

    plan = call_table_plan(session, statements)
    assert plan
    assert unscoped_call_access(plan) == []


@pytest.mark.usefixtures("schema")
def test_membership_scope_never_reads_calls_outside_its_projects(
    session: Session,
) -> None:
    seed_two_projects(session)

    with captured_statements(session) as statements:
        _ids(
            session,
            allowed_projects=[SMALL],
            status_values=["error", "warning", "success"],
            models=["m-shared"],
        )

    plan = call_table_plan(session, statements)
    assert plan
    assert unscoped_call_access(plan) == []


@pytest.mark.usefixtures("schema")
def test_facets_never_read_calls_outside_the_project(
    client: TestClient, session: Session
) -> None:
    seed_two_projects(session)

    with captured_statements(session) as statements:
        response = client.get(
            "/v1/runs/facets",
            params={"project": SMALL, "status": "error,warning,success", "models": "m-shared"},
        )

    assert response.status_code == 200
    plan = call_table_plan(session, statements)
    assert plan
    assert unscoped_call_access(plan) == []


def test_scoped_subqueries_seek_the_composite_indexes(session: Session) -> None:
    # The pairing this module exists for: a project-scoped subquery plus a
    # project-led index is an index-only seek. If the subquery ever stops
    # matching the index prefix, the plan silently falls back to walking the
    # project's whole call history.
    for ddl in _COMPOSITE_INDEXES:
        session.connection().exec_driver_sql(ddl)
    session.commit()
    seed_two_projects(session)

    with captured_statements(session) as status_statements:
        _ids(session, project=SMALL, status_values=["error", "warning", "success"])
    with captured_statements(session) as model_statements:
        _ids(session, project=SMALL, models=["m-shared"])

    # The first statement is the filtered page query; the rest is hydration.
    status_plan = call_table_plan(session, status_statements[:1])
    model_plan = call_table_plan(session, model_statements[:1])
    assert status_plan and all(
        "ix_logged_calls_project_level_run_id (project=? AND level=?" in line
        for line in status_plan
    ), status_plan
    assert model_plan and all(
        "ix_logged_calls_project_model_run_id (project=? AND model=?" in line
        for line in model_plan
    ), model_plan


# ---------------------------------------------------------------------------
# Facets are computed by the database, not from id lists
# ---------------------------------------------------------------------------


def _widest_statement(statements: list[Statement]) -> int:
    return max(len(parameters or ()) for _, parameters in statements)


def test_facet_statements_do_not_grow_with_the_number_of_runs(
    client: TestClient, session: Session
) -> None:
    # Binding every matching run id into each facet query grows with the
    # project and stops working past the driver's parameter limit.
    seed_two_projects(session, big_runs=10)
    with captured_statements(session) as few:
        assert client.get("/v1/runs/facets", params={"project": BIG}).status_code == 200

    for index in range(10, 60):
        session.add(_run(f"big-{index}", BIG, call_count=0, minutes=index))
    session.commit()
    with captured_statements(session) as many:
        assert client.get("/v1/runs/facets", params={"project": BIG}).status_code == 200

    assert _widest_statement(many) == _widest_statement(few)
    assert len(many) == len(few)


# ---------------------------------------------------------------------------
# The column diets: hydration and serving rows carry only what they read
# ---------------------------------------------------------------------------


def test_hydration_issues_no_per_call_statements(session: Session) -> None:
    # The metric rollups read raw_usage off every hydrated call. With the
    # column deferred, that is one SELECT per call per page; loaded with the
    # row, it is the one hydration statement regardless of call count.
    seed_two_projects(session, big_runs=4)

    with captured_statements(session) as few:
        _ids(session, project=BIG)
    call_statements = [s for s in few if "logged_calls" in s[0]]

    for index in range(4):
        run_id = f"big-{index}"
        for call in range(5):
            session.add(
                _call(f"{run_id}-x{call}", run_id, BIG, model="m-big-only")
            )
    session.commit()

    with captured_statements(session) as many:
        _ids(session, project=BIG)
    grown = [s for s in many if "logged_calls" in s[0]]

    assert call_statements, "hydration is expected to consult logged_calls"
    assert len(grown) == len(call_statements)


def test_load_call_rows_ships_only_the_serving_columns(session: Session) -> None:
    from sqlalchemy import inspect as sa_inspect
    from sqlalchemy.exc import InvalidRequestError
    from sqlmodel import select as sm_select

    from apo.services.serving import load_call_rows, summarize_calls

    seed_two_projects(session)
    grouped = load_call_rows(session, project=SMALL, run_ids=["s-ok"])
    rows = grouped["s-ok"]
    assert rows

    state = sa_inspect(rows[0])
    for column in ("input", "messages", "output", "tool_parameters", "tool_result", "meta"):
        assert column in state.unloaded, column
    with pytest.raises(InvalidRequestError):
        _ = rows[0].input

    # The serving columns are all there: the summary over diet rows equals
    # the summary over fully loaded rows.
    full_rows = session.exec(
        sm_select(LoggedCallDB).where(
            LoggedCallDB.run_id == "s-ok", LoggedCallDB.project == SMALL
        )
    ).all()
    assert summarize_calls(rows) == summarize_calls(full_rows)
