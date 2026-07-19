# pyright: reportAny=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

import pytest
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.models import RunDB
from apo.routes.runs.navigation import get_adjacent_runs


def _create_run(session: Session, run_id: str, created_at: datetime, duration_ms: int | None = None, call_count: int = 1) -> RunDB:
    run = RunDB(id=run_id, project="p", created_at=created_at, duration_ms=duration_ms, call_count=call_count)
    session.add(run)
    return run


def test_middle_run_desc_has_both_adjacent(session: Session):
    now = datetime.now(timezone.utc)
    _create_run(session, "r1", now - timedelta(minutes=2))
    _create_run(session, "r2", now - timedelta(minutes=1))
    _create_run(session, "r3", now)
    session.commit()

    result = get_adjacent_runs("r2", sort_by="created_at", sort_order="desc", project="p", session=session)

    assert result.prev_id == "r1"
    assert result.next_id == "r3"


def test_newest_run_desc_no_next(session: Session):
    now = datetime.now(timezone.utc)
    _create_run(session, "r1", now - timedelta(minutes=1))
    _create_run(session, "r2", now)
    session.commit()

    result = get_adjacent_runs("r2", sort_by="created_at", sort_order="desc", project="p", session=session)

    assert result.prev_id == "r1"
    assert result.next_id is None


def test_oldest_run_desc_no_prev(session: Session):
    now = datetime.now(timezone.utc)
    _create_run(session, "r1", now - timedelta(minutes=1))
    _create_run(session, "r2", now)
    session.commit()

    result = get_adjacent_runs("r1", sort_by="created_at", sort_order="desc", project="p", session=session)

    assert result.prev_id is None
    assert result.next_id == "r2"


def test_single_run_both_none(session: Session):
    now = datetime.now(timezone.utc)
    _create_run(session, "r1", now)
    session.commit()

    result = get_adjacent_runs("r1", sort_by="created_at", sort_order="desc", project="p", session=session)

    assert result.prev_id is None
    assert result.next_id is None


def test_ascending_order_middle(session: Session):
    now = datetime.now(timezone.utc)
    _create_run(session, "r1", now - timedelta(minutes=2))
    _create_run(session, "r2", now - timedelta(minutes=1))
    _create_run(session, "r3", now)
    session.commit()

    result = get_adjacent_runs("r2", sort_by="created_at", sort_order="asc", project="p", session=session)

    assert result.prev_id == "r3"
    assert result.next_id == "r1"


def test_oldest_run_asc_no_next(session: Session):
    now = datetime.now(timezone.utc)
    _create_run(session, "r1", now - timedelta(minutes=1))
    _create_run(session, "r2", now)
    session.commit()

    result = get_adjacent_runs("r1", sort_by="created_at", sort_order="asc", project="p", session=session)

    assert result.prev_id == "r2"
    assert result.next_id is None


def test_newest_run_asc_no_prev(session: Session):
    now = datetime.now(timezone.utc)
    _create_run(session, "r1", now - timedelta(minutes=1))
    _create_run(session, "r2", now)
    session.commit()

    result = get_adjacent_runs("r2", sort_by="created_at", sort_order="asc", project="p", session=session)

    assert result.prev_id is None
    assert result.next_id == "r1"


def test_sort_by_duration(session: Session):
    now = datetime.now(timezone.utc)
    _create_run(session, "r1", now, duration_ms=100)
    _create_run(session, "r2", now, duration_ms=200)
    _create_run(session, "r3", now, duration_ms=300)
    session.commit()

    result = get_adjacent_runs("r2", sort_by="duration_ms", sort_order="desc", project="p", session=session)

    assert result.prev_id == "r1"
    assert result.next_id == "r3"


def test_sort_by_call_count_asc(session: Session):
    now = datetime.now(timezone.utc)
    _create_run(session, "r1", now, call_count=1)
    _create_run(session, "r2", now, call_count=5)
    _create_run(session, "r3", now, call_count=10)
    session.commit()

    result = get_adjacent_runs("r2", sort_by="call_count", sort_order="asc", project="p", session=session)

    assert result.prev_id == "r3"
    assert result.next_id == "r1"


def test_invalid_sort_field_defaults_to_created_at(session: Session):
    now = datetime.now(timezone.utc)
    _create_run(session, "r1", now - timedelta(minutes=1))
    _create_run(session, "r2", now)
    session.commit()

    result = get_adjacent_runs("r2", sort_by="invalid_field", sort_order="desc", project="p", session=session)

    assert result.prev_id == "r1"
    assert result.next_id is None


def test_nonexistent_run_returns_404(client: TestClient):
    response = client.get("/v1/runs/nonexistent/adjacent?project=p")

    assert response.status_code == 404


def test_api_endpoint_returns_adjacent(client: TestClient, session: Session):
    now = datetime.now(timezone.utc)
    _create_run(session, "r1", now - timedelta(minutes=1))
    _create_run(session, "r2", now)
    session.commit()

    response = client.get("/v1/runs/r2/adjacent?project=p")

    assert response.status_code == 200
    data = response.json()
    assert data["prev_id"] == "r1"
    assert data["next_id"] is None


def test_api_endpoint_with_sort_params(client: TestClient, session: Session):
    now = datetime.now(timezone.utc)
    _create_run(session, "r1", now, duration_ms=100)
    _create_run(session, "r2", now, duration_ms=200)
    _create_run(session, "r3", now, duration_ms=300)
    session.commit()

    response = client.get("/v1/runs/r2/adjacent?project=p&sort_by=duration_ms&sort_order=asc")

    assert response.status_code == 200
    data = response.json()
    assert data["prev_id"] == "r3"
    assert data["next_id"] == "r1"


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main(["-v", __file__]))
