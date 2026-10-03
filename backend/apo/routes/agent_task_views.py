"""— evidence view comparison + saved-view routes.

Comparison: POST creates an immutable snapshot (resolves both sides, freezes
run ids + revisions + coverage); GET reads one by its short opaque id.

Saved views: GET lists the caller's tabs for a project; POST/PATCH/DELETE
manage them so derived tabs persist across refresh / cross-device.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session, select

from ..auth.deps import get_user_id
from ..db import get_session
from ..models.db import ProjectDB, TaskViewDB
from ..models.schemas import (
    ResolvedComparisonCell,
    TaskComparisonEvidence,
    TaskViewComparisonOverview,
    TaskViewComparisonRequest,
    TaskViewComparisonSnapshot,
    TaskViewCreateRequest,
    TaskViewResponse,
    TaskViewUpdateRequest,
    as_no_verdict_reason,
    as_task_run_status,
)
from ..services.agent_task_run_details import load_task_run_details, load_task_run_summaries
from ..services.project_memberships import enforce_project_read_from_request
from ..services.lifecycle import TASK_RUN_TERMINAL
from ..services.task_view_comparison import create_comparison, get_comparison, to_snapshot

router = APIRouter(prefix="/v1/projects/{project_id}", tags=["task-views"])
SessionDependency = Annotated[Session, Depends(get_session)]


def _authorize(session: Session, project_id: str, request: Request) -> None:
    """404 if the project is missing, 403 if the caller is not a member.

    The canonical credential-aware guard also confines API keys
    to their bound Project — a B-bound key cannot read A's views or
    comparison evidence even when its creator is a member of A.
    """
    project = session.get(ProjectDB, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    _ = enforce_project_read_from_request(request, session, project_id)


def _to_response(row: TaskViewDB) -> TaskViewResponse:
    return TaskViewResponse(
        id=row.id,
        project_id=row.project_id,
        label=row.label,
        model=row.model,
        effort=row.effort,
        since=row.since,
        provider=row.provider,
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
            created_by=get_user_id(request),
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get(
    "/task-view-comparisons/{comparison_id}/overview",
    response_model=TaskViewComparisonOverview,
)
async def get_task_view_comparison_overview(
    project_id: str,
    comparison_id: str,
    request: Request,
    session: SessionDependency,
) -> TaskViewComparisonOverview:
    """Read a frozen snapshot and lightweight summaries for all resolved runs.

    Never loads Check Reports, Task Definition bodies, transcripts, or
    Deliverable JSON. Response size grows with summary count, not evidence size.
    """
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
    summaries = load_task_run_summaries(session, run_ids, project_id=project_id)
    # Overlay the frozen verdict/count scalars from the snapshot
    # onto the live-run summaries. Summaries read the *current* effective
    # projection; corrections made after this snapshot must not leak into it.
    # Load-bearing fields that are not frozen (cost, tokens, model) stay live.
    frozen_by_run: dict[str, ResolvedComparisonCell] = {}
    for cell in snapshot.resolved:
        for run_id in (cell.a_run_id, cell.b_run_id):
            if run_id is not None:
                frozen_by_run[run_id] = cell
    for summary in summaries:
        cell = frozen_by_run.get(summary.id)
        if cell is None:
            continue
        is_a = cell.a_run_id == summary.id
        status = cell.a_status if is_a else cell.b_status
        pass_result = cell.a_pass_result if is_a else cell.b_pass_result
        total = cell.a_total_checks if is_a else cell.b_total_checks
        passed = cell.a_passed_checks if is_a else cell.b_passed_checks
        errored = cell.a_errored_checks if is_a else cell.b_errored_checks
        corrected = cell.a_corrected_tests if is_a else cell.b_corrected_tests
        reason_field = "a_no_verdict_reason" if is_a else "b_no_verdict_reason"
        reason = cell.a_no_verdict_reason if is_a else cell.b_no_verdict_reason
        # Only a verdict frozen on a terminal run is a verdict: a snapshot
        # taken while the run was still live froze placeholders, and the
        # live projection is the truth for it.
        if status is not None and status not in TASK_RUN_TERMINAL:
            continue
        # Verdict and counts come from the same frozen moment: a snapshot
        # that froze its scalars (``total`` set) overlays status, pass_result
        # and the no-verdict reason together — including a frozen no-verdict
        # ``None`` (#323) — so a later correction can't mix live and frozen
        # state.
        if total is not None:
            live_status = summary.status
            if status is not None:
                summary.status = as_task_run_status(status)
            summary.pass_result = pass_result
            # A snapshot frozen before the reason existed keeps the live one
            # while the live run still has the frozen status.
            if reason_field in cell.model_fields_set or live_status != status:
                summary.no_verdict_reason = as_no_verdict_reason(reason)
        elif pass_result is not None:
            summary.pass_result = pass_result
            summary.status = "passed" if pass_result else "failed"
        if total is not None:
            summary.total_checks = total
        if passed is not None:
            summary.passed_checks = passed
            summary.failed_checks = max((total or 0) - passed - (errored or 0), 0)
        if errored is not None:
            summary.errored_checks = errored
        if corrected is not None:
            summary.corrected_tests = corrected

    return TaskViewComparisonOverview(
        snapshot=snapshot,
        runs=summaries,
    )


@router.get(
    "/task-view-comparisons/{comparison_id}/task-evidence",
    response_model=TaskComparisonEvidence,
)
async def get_task_comparison_evidence(
    project_id: str,
    comparison_id: str,
    task_id: str,
    request: Request,
    session: SessionDependency,
) -> TaskComparisonEvidence:
    """Detailed evidence for one task in a frozen comparison.

    The backend resolves both run IDs from the authorized immutable snapshot
    and the requested task ID. The client never supplies run IDs.
    """
    _authorize(session, project_id, request)
    row = get_comparison(session, project_id, comparison_id)
    if row is None or row.project_id != project_id:
        raise HTTPException(status_code=404, detail="Comparison not found")

    snapshot = to_snapshot(row)
    cell = next((c for c in snapshot.resolved if c.task_id == task_id), None)
    if cell is None:
        raise HTTPException(status_code=404, detail="Task not found in comparison")

    pair_ids = list(
        dict.fromkeys(
            rid for rid in (cell.a_run_id, cell.b_run_id) if rid is not None
        )
    )
    # Evidence renders the run as it was effective when the
    # snapshot was frozen — corrections made later must not leak in.
    details = load_task_run_details(
        session, pair_ids, project_id=project_id, corrections_as_of=row.created_at
    )
    detail_by_id = {d.id: d for d in details}

    # Spec rule 8 / error table: a frozen run that cannot be resolved is a
    # server error, not a silent null. Returning null makes the frontend
    # show "Not run" for a side that definitely ran.
    missing = [rid for rid in pair_ids if rid not in detail_by_id]
    if missing:
        raise HTTPException(
            status_code=500,
            detail=f"Snapshot references unresolved run(s): {missing}",
        )

    return TaskComparisonEvidence(
        task_id=task_id,
        left=detail_by_id.get(cell.a_run_id) if cell.a_run_id else None,
        right=detail_by_id.get(cell.b_run_id) if cell.b_run_id else None,
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


@router.get("/task-view-comparisons/{comparison_id}/card")
async def get_comparison_card(
    project_id: str,
    comparison_id: str,
    session: SessionDependency,
) -> dict[str, str | None]:
    """Public: return only view model names for OG image previews. No auth."""
    row = get_comparison(session, project_id, comparison_id)
    if row is None or row.project_id != project_id:
        raise HTTPException(status_code=404, detail="Comparison not found")
    snapshot = to_snapshot(row)
    return {
        "view_a": snapshot.view_a_config.model,
        "view_b": snapshot.view_b_config.model,
    }


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
    user_id = get_user_id(request)
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
    user_id = get_user_id(request)
    row = TaskViewDB(
        project_id=project_id,
        user_id=user_id,
        label=body.label,
        model=body.model,
        effort=body.effort,
        since=body.since,
        provider=body.provider,
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
    user_id = get_user_id(request)
    row = session.get(TaskViewDB, view_id)
    if row is None or row.project_id != project_id or row.user_id != user_id:
        raise HTTPException(status_code=404, detail="View not found")
    # PATCH distinguishes an omitted field from an explicit null. The latter
    # clears nullable filters (for example, ``since=null`` means All time).
    # ``label`` is not nullable, so a null label remains a no-op.
    if "label" in body.model_fields_set and body.label is not None:
        row.label = body.label
    for field in ("model", "effort", "since", "provider"):
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
    user_id = get_user_id(request)
    row = session.get(TaskViewDB, view_id)
    if row is None or row.project_id != project_id or row.user_id != user_id:
        raise HTTPException(status_code=404, detail="View not found")
    session.delete(row)
    session.commit()
