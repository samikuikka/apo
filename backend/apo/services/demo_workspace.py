"""Demo workspace: read-only guards and startup ensure.

The demo project (``id="demo"``) is world-readable and permanently
read-only: browsing is open (anonymous visitors read as viewer), every
mutation is rejected. Its data comes from the shipped fixture
(``services/demo_fixture.py``), not from execution — the old executor-based
seeding was retired.
"""

from datetime import datetime, timezone

from fastapi import HTTPException
from sqlmodel import Session, select

from ..db import engine
from ..models.db import (
    AgentTaskBatchRunDB,
    LoggedCallDB,
    ProjectDB,
    RunDB,
)

DEMO_PROJECT_ID = "demo"

DEMO_READ_ONLY_MESSAGE = "Demo workspace is read-only"
DEMO_READ_ONLY_STATUS = 403


def is_demo_enabled() -> bool:
    """APO_DEMO_ENABLED=false removes the demo from this install entirely.

    Mirrors the middleware's gate (auth/middleware.py); kept local so the
    service layer never imports the auth stack.
    """
    import os

    return os.environ.get("APO_DEMO_ENABLED", "true").strip().lower() not in (
        "false",
        "0",
        "no",
    )


def require_project_not_demo(project: str | None) -> None:
    """Raise if a mutation targets the shared demo project."""
    if project == DEMO_PROJECT_ID:
        raise HTTPException(
            status_code=DEMO_READ_ONLY_STATUS,
            detail=DEMO_READ_ONLY_MESSAGE,
        )


def require_run_not_demo(session: Session, run_id: str, project: str | None = None) -> RunDB:
    """Fetch a run and reject if it belongs to the demo project.

    When ``project`` is given, the lookup is scoped by ``(id, project)`` so two
    Projects sharing an OTel trace id cannot resolve to each other's run.
    Callers with an authenticated Project should always pass it.
    """
    statement = select(RunDB).where(RunDB.id == run_id)
    if project is not None:
        statement = statement.where(RunDB.project == project)
    run = session.exec(statement).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    require_project_not_demo(run.project)
    return run


def require_call_not_demo(
    session: Session, call_id: str, project: str | None = None
) -> LoggedCallDB:
    """Fetch a call and reject if its trace belongs to the demo project.

    When ``project`` is given, the lookup is scoped by ``(id, project)`` so two
    Projects sharing an OTel span id cannot resolve to each other's call.
    """
    statement = select(LoggedCallDB).where(LoggedCallDB.id == call_id)
    if project is not None:
        statement = statement.where(LoggedCallDB.project == project)
    call = session.exec(statement).first()
    if not call or not call.run_id:
        raise HTTPException(status_code=404, detail="Call not found")
    run_statement = select(RunDB).where(RunDB.id == call.run_id)
    if project is not None:
        run_statement = run_statement.where(RunDB.project == project)
    run = session.exec(run_statement).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    require_project_not_demo(run.project)
    return call


def ensure_demo_project_exists(session: Session | None = None) -> bool:
    """Ensure the demo ``ProjectDB`` row exists. Returns whether the demo is enabled.

    Kill-switched: with ``APO_DEMO_ENABLED=false`` nothing is created and the
    fixture loader (api.py lifespan) is skipped. Data loading itself lives in
    ``services/demo_fixture.py``.
    """
    if not is_demo_enabled():
        return False

    own_session = session is None
    active = session if session is not None else Session(engine)
    try:
        existing = active.get(ProjectDB, DEMO_PROJECT_ID)
        if existing is None:
            now = datetime.now(timezone.utc)
            active.add(ProjectDB(
                id=DEMO_PROJECT_ID,
                name="Demo workspace",
                created_by=None,
                created_at=now,
                updated_at=now,
            ))
            active.commit()
        return True
    finally:
        if own_session:
            active.close()
