# pyright: reportAny=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedImport=false, reportAttributeAccessIssue=false

import pytest
from fastapi import HTTPException
from sqlmodel import Session, select
from datetime import datetime, timezone

from apo.models import LoggedCallDB, RunDB
from apo.routes.public import get_public_trace, toggle_visibility


def _create_public_run(session: Session, run_id: str = "pub-run-1", is_public: bool = True) -> RunDB:
    now = datetime.now(timezone.utc)
    run = RunDB(
        id=run_id,
        project="p",
        task_id="t",
        flow_name="flow1",
        created_at=now,
        call_count=1,
        is_public=is_public,
    )
    session.add(run)
    session.commit()
    session.refresh(run)
    return run


def _create_call(session: Session, call_id: str = "c1", run_id: str = "pub-run-1") -> LoggedCallDB:
    now = datetime.now(timezone.utc)
    call = LoggedCallDB(
        id=call_id,
        project="p",
        model="gpt-4",
        task_id="t",
        run_id=run_id,
        flow_name="flow1",
        created_at=now,
        step_index=0,
        input={"prompt": "hello"},
        messages=[],
        output={"text": "world"},
    )
    session.add(call)
    session.commit()
    return call


def test_get_public_trace_returns_trace(session: Session):
    _create_public_run(session, is_public=True)
    _create_call(session)

    result = get_public_trace("pub-run-1", project="p", session=session)

    assert result["run"]["id"] == "pub-run-1"
    assert result["run"]["is_public"] is True
    assert len(result["calls"]) == 1
    assert result["calls"][0]["id"] == "c1"


def test_get_public_trace_private_returns_404(session: Session):
    _create_public_run(session, is_public=False)

    with pytest.raises(HTTPException) as exc_info:
        get_public_trace("pub-run-1", project="p", session=session)
    assert exc_info.value.status_code == 404


def test_get_public_trace_nonexistent_returns_404(session: Session):
    with pytest.raises(HTTPException) as exc_info:
        get_public_trace("nonexistent", project="p", session=session)
    assert exc_info.value.status_code == 404


def test_toggle_visibility_publish(session: Session):
    _create_public_run(session, is_public=False)

    result = toggle_visibility("pub-run-1", project="p", session=session)

    assert result["id"] == "pub-run-1"
    assert result["is_public"] is True

    run = session.exec(select(RunDB).where(RunDB.id == "pub-run-1")).first()
    assert run is not None
    assert run.is_public is True


def test_toggle_visibility_unpublish(session: Session):
    _create_public_run(session, is_public=True)

    result = toggle_visibility("pub-run-1", project="p", session=session)

    assert result["is_public"] is False

    run = session.exec(select(RunDB).where(RunDB.id == "pub-run-1")).first()
    assert run is not None
    assert run.is_public is False


def test_toggle_visibility_nonexistent_returns_404(session: Session):
    with pytest.raises(HTTPException) as exc_info:
        toggle_visibility("nonexistent", project="p", session=session)
    assert exc_info.value.status_code == 404


def test_publish_then_get_public_trace(session: Session):
    _create_public_run(session, is_public=False)
    _create_call(session)

    with pytest.raises(HTTPException):
        get_public_trace("pub-run-1", project="p", session=session)

    toggle_visibility("pub-run-1", project="p", session=session)

    result = get_public_trace("pub-run-1", project="p", session=session)
    assert result["run"]["is_public"] is True


def test_unpublish_then_public_url_404(session: Session):
    _create_public_run(session, is_public=True)
    _create_call(session)

    result = get_public_trace("pub-run-1", project="p", session=session)
    assert result["run"]["id"] == "pub-run-1"

    toggle_visibility("pub-run-1", project="p", session=session)

    with pytest.raises(HTTPException) as exc_info:
        get_public_trace("pub-run-1", project="p", session=session)
    assert exc_info.value.status_code == 404


def test_get_public_trace_includes_metrics(session: Session):
    _create_public_run(session, is_public=True)
    _create_call(session)

    result = get_public_trace("pub-run-1", project="p", session=session)

    assert "metrics" in result
    assert isinstance(result["metrics"], list)


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main(["-v", __file__]))
