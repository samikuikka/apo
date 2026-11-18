"""Exact-id task lookup over the project task inventory.

The task detail page resolves one task per render through the inventory
list endpoint. A substring ``grep`` makes the service load the project's
whole inventory and match in Python, and cannot tell ``a/b`` from
``a/bc``. The ``ids`` membership filter answers in SQL (an indexed
``task_id IN``), so one row crosses the wire for one task.
"""

# pyright: reportAny=false, reportExplicitAny=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUntypedFunctionDecorator=false, reportUnusedCallResult=false

from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlmodel import Session

from apo.models.db import (
    ProjectDB,
    ProjectMembershipDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    UserDB,
)
from apo.services.project_task_inventory import list_inventory_for_project

_USER = "user-ids-filter"
_PROJECT = "proj-ids-filter"

Statement = tuple[str, Any]


def _seed_source(session: Session) -> ProjectTaskSourceDB:
    now = datetime.now(timezone.utc)
    session.add(UserDB(id=_USER, email=f"{_USER}@test", name="Ids Owner", password_hash="x"))
    session.commit()
    session.add(ProjectDB(id=_PROJECT, name=_PROJECT, created_by=_USER, created_at=now))
    session.commit()
    session.add(
        ProjectMembershipDB(
            project_id=_PROJECT, user_id=_USER, role="owner", created_at=now, updated_at=now
        )
    )
    session.commit()
    source = ProjectTaskSourceDB(project=_PROJECT, source_type="published", status="ready")
    session.add(source)
    session.commit()
    return source


def _inventory_row(source: ProjectTaskSourceDB, task_id: str) -> ProjectTaskInventoryDB:
    folder, _, name = task_id.rpartition("/")
    return ProjectTaskInventoryDB(
        project=_PROJECT,
        task_source_id=source.id,
        task_id=task_id,
        display_name=name,
        folder_path=folder,
        task_path=task_id,
        source_type=source.source_type,
    )


def _seed_tasks(session: Session, *task_ids: str) -> None:
    source = _seed_source(session)
    for task_id in task_ids:
        session.add(_inventory_row(source, task_id))
    session.commit()


def _list_capturing_statements(
    session: Session, **filters: Any
) -> tuple[list[str], list[Statement]]:
    engine = session.get_bind()
    statements: list[Statement] = []

    def _capture(_conn, _cursor, statement, parameters, _context, _executemany) -> None:
        statements.append((statement, parameters))

    event.listen(engine, "before_cursor_execute", _capture)
    try:
        rows = list_inventory_for_project(session, _PROJECT, **filters)
    finally:
        event.remove(engine, "before_cursor_execute", _capture)
    return sorted(row.task_id for row in rows), statements


def test_ids_filter_is_exact_and_sql_side(session: Session) -> None:
    _seed_tasks(session, "a/b", "a/bc", "x/y")

    ids, statements = _list_capturing_statements(session, ids=["a/b"])

    assert ids == ["a/b"]
    select = next(
        statement for statement, _ in statements if statement.lstrip().upper().startswith("SELECT")
    )
    assert "task_id IN" in select


def test_ids_and_grep_combine_with_and(session: Session) -> None:
    _seed_tasks(session, "a/b", "a/bc", "x/y")

    assert _list_capturing_statements(session, ids=["a/b", "a/bc"], grep="x")[0] == []
    assert _list_capturing_statements(session, ids=["a/b", "a/bc"], grep="bc")[0] == ["a/bc"]


def test_empty_ids_is_treated_as_absent(session: Session) -> None:
    _seed_tasks(session, "a/b", "a/bc", "x/y")

    assert _list_capturing_statements(session, ids=[])[0] == ["a/b", "a/bc", "x/y"]


def test_list_route_honors_repeatable_ids(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed_tasks(session, "a/b", "a/bc", "x/y")
    client = make_authed_client(_USER, session)

    response = client.get(
        f"/v1/projects/{_PROJECT}/agent-tasks",
        params=[("ids", "a/b"), ("ids", "x/y")],
    )

    assert response.status_code == 200
    assert sorted(summary["id"] for summary in response.json()) == ["a/b", "x/y"]


def test_list_route_unknown_ids_answer_empty(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed_tasks(session, "a/b", "a/bc", "x/y")
    client = make_authed_client(_USER, session)

    response = client.get(
        f"/v1/projects/{_PROJECT}/agent-tasks", params=[("ids", "missing/id")]
    )

    assert response.status_code == 200
    assert response.json() == []


def test_list_route_blank_ids_value_is_absent(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed_tasks(session, "a/b", "a/bc", "x/y")
    client = make_authed_client(_USER, session)

    response = client.get(f"/v1/projects/{_PROJECT}/agent-tasks", params=[("ids", "")])

    assert response.status_code == 200
    assert sorted(summary["id"] for summary in response.json()) == ["a/b", "a/bc", "x/y"]
