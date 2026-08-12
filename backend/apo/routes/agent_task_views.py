"""SPEC-174 — evidence view comparison + saved-view routes.

Comparison: POST creates an immutable snapshot (resolves both sides, freezes
run ids + revisions + coverage); GET reads one by its short opaque id.

Saved views: GET lists the caller's tabs for a project; POST/PATCH/DELETE
manage them so derived tabs persist across refresh / cross-device.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session, select

from ..db import get_session
from ..models.db import ProjectDB, TaskViewDB
from ..models.schemas import (
    TaskViewComparisonRequest,
    TaskViewComparisonEvidence,
    TaskViewComparisonSnapshot,
    TaskViewCreateRequest,
    TaskViewResponse,
    TaskViewUpdateRequest,
)
from ..services.agent_task_run_details import load_task_run_details
from ..services.project_memberships import require_project_member
from ..services.task_view_comparison import create_comparison, get_comparison, to_snapshot

router = APIRouter(prefix="/v1/projects/{project_id}", tags=["task-views"])
SessionDependency = Annotated[Session, Depends(get_session)]


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
    _ = require_project_member(session, project_id, _get_user_id(request))


def _to_response(row: TaskViewDB) -> TaskViewResponse:
    return TaskViewResponse(
        id=row.id,
        project_id=row.project_id,
        label=row.label,
        model=row.model,
        effort=row.effort,
        since=row.since,
    )


# ---------------------------------------------------------------------------
# Comparison snapshots
# ---------------------------------------------------------------------------

@router.post("/task-view-comparisons", response_model=TaskViewComparisonSnapshot, status_code=201)
async def create_task_view_comparison(
    project_id: str,
    body: TaskViewComparisonRequest,
    request: Request,
    session: SessionDependency,
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


@router.get(
    "/task-view-comparisons/{comparison_id}/evidence",
    response_model=TaskViewComparisonEvidence,
)
async def get_task_view_comparison_evidence(
    project_id: str,
    comparison_id: str,
    request: Request,
    session: SessionDependency,
) -> TaskViewComparisonEvidence:
    """Read a frozen snapshot and all of its resolved run evidence in bulk."""
    _authorize(session, project_id, request)
    row = get_comparison(session, project_id, comparison_id)
    if row is None or row.project_id != project_id:
        raise HTTPException(status_code=404, detail="Comparison not found")

    snapshot = to_snapshot(row)
    run_ids = list(
        dict.fromkeys(
            run_id
            for cell in snapshot.resolved
            for run_id in (cell.a_run_id, cell.b_run_id)
            if run_id is not None
        )
    )
    return TaskViewComparisonEvidence(
        snapshot=snapshot,
        runs=load_task_run_details(session, run_ids, project_id=project_id),
    )


@router.get("/task-view-comparisons/{comparison_id}", response_model=TaskViewComparisonSnapshot)
async def get_task_view_comparison(
    project_id: str,
    comparison_id: str,
    request: Request,
    session: SessionDependency,
) -> TaskViewComparisonSnapshot:
    """Read a snapshot by id (shareable, reload-stable). Scoped to its project."""
    _authorize(session, project_id, request)
    row = get_comparison(session, project_id, comparison_id)
    if row is None or row.project_id != project_id:
        raise HTTPException(status_code=404, detail="Comparison not found")
    return to_snapshot(row)


# ---------------------------------------------------------------------------
# Saved evidence views (persistent tabs)
# ---------------------------------------------------------------------------

@router.get("/task-views", response_model=list[TaskViewResponse])
async def list_task_views(
    project_id: str,
    request: Request,
    session: SessionDependency,
) -> list[TaskViewResponse]:
    """List the caller's saved evidence-view tabs for the project."""
    _authorize(session, project_id, request)
    user_id = _get_user_id(request)
    rows = session.exec(
        select(TaskViewDB)
        .where(TaskViewDB.project_id == project_id, TaskViewDB.user_id == user_id)
        .order_by("created_at")
    ).all()
    return [_to_response(r) for r in rows]


@router.post("/task-views", response_model=TaskViewResponse, status_code=201)
async def create_task_view(
    project_id: str,
    body: TaskViewCreateRequest,
    request: Request,
    session: SessionDependency,
) -> TaskViewResponse:
    """Create a saved evidence-view tab."""
    _authorize(session, project_id, request)
    user_id = _get_user_id(request)
    row = TaskViewDB(
        project_id=project_id,
        user_id=user_id,
        label=body.label,
        model=body.model,
        effort=body.effort,
        since=body.since,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return _to_response(row)


@router.patch("/task-views/{view_id}", response_model=TaskViewResponse)
async def update_task_view(
    project_id: str,
    view_id: str,
    body: TaskViewUpdateRequest,
    request: Request,
    session: SessionDependency,
) -> TaskViewResponse:
    """Update a saved evidence-view tab (label / model / effort / since)."""
    _authorize(session, project_id, request)
    user_id = _get_user_id(request)
    row = session.get(TaskViewDB, view_id)
    if row is None or row.project_id != project_id or row.user_id != user_id:
        raise HTTPException(status_code=404, detail="View not found")
    # PATCH distinguishes an omitted field from an explicit null. The latter
    # clears nullable filters (for example, ``since=null`` means All time).
    # ``label`` is not nullable, so a null label remains a no-op.
    if "label" in body.model_fields_set and body.label is not None:
        row.label = body.label
    for field in ("model", "effort", "since"):
        if field in body.model_fields_set:
            setattr(row, field, getattr(body, field))
    row.updated_at = datetime.now(timezone.utc)
    session.add(row)
    session.commit()
    session.refresh(row)
    return _to_response(row)


@router.delete("/task-views/{view_id}", status_code=204)
async def delete_task_view(
    project_id: str,
    view_id: str,
    request: Request,
    session: SessionDependency,
) -> None:
    """Delete a saved evidence-view tab."""
    _authorize(session, project_id, request)
    user_id = _get_user_id(request)
    row = session.get(TaskViewDB, view_id)
    if row is None or row.project_id != project_id or row.user_id != user_id:
        raise HTTPException(status_code=404, detail="View not found")
    session.delete(row)
    session.commit()
