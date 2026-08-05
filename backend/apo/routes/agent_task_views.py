"""SPEC-174 Phase 2 — selection-scoped view comparison routes.

POST creates an immutable snapshot (resolves both sides, freezes run ids +
revisions + coverage); GET reads one by its short opaque id. The snapshot id is
the only thing in the shareable URL — task selections are never URL-encoded.
"""

from __future__ import annotations

from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session

from ..db import get_session
from ..models.db import ProjectDB
from ..models.schemas import TaskViewComparisonRequest, TaskViewComparisonSnapshot
from ..services.project_memberships import require_project_member
from ..services.task_view_comparison import create_comparison, get_comparison, to_snapshot

router = APIRouter(prefix="/v1/projects/{project_id}", tags=["task-views"])

_DEMO_BYPASS_MSG = "demo workspace bypasses membership"


def _get_user_id(request: Request) -> str:
    user_id = cast(str | None, getattr(request.state, "user_id", None))
    if user_id:
        return user_id
    raise HTTPException(status_code=401, detail="Authentication required")


def _authorize(session: Session, project_id: str, request: Request) -> None:
    """404 if the project is missing, 403 if the caller is not a member."""
    project = session.get(ProjectDB, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    require_project_member(session, project_id, _get_user_id(request))


@router.post("/task-view-comparisons", response_model=TaskViewComparisonSnapshot, status_code=201)
async def create_task_view_comparison(
    project_id: str,
    body: TaskViewComparisonRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> TaskViewComparisonSnapshot:
    """Resolve + freeze a selection-scoped comparison, return the snapshot."""
    _authorize(session, project_id, request)
    try:
        return create_comparison(
            session,
            project_id=project_id,
            task_ids=body.task_ids,
            view_a=body.view_a,
            view_b=body.view_b,
            created_by=_get_user_id(request),
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/task-view-comparisons/{comparison_id}", response_model=TaskViewComparisonSnapshot)
async def get_task_view_comparison(
    project_id: str,
    comparison_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> TaskViewComparisonSnapshot:
    """Read a snapshot by id (shareable, reload-stable). Scoped to its project."""
    _authorize(session, project_id, request)
    row = get_comparison(session, project_id, comparison_id)
    if row is None or row.project_id != project_id:
        raise HTTPException(status_code=404, detail="Comparison not found")
    return to_snapshot(row)
