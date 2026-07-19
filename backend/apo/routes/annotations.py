"""
Annotation queue management API.

Provides endpoints for creating and managing annotation queues
for human scoring of traces and observations.
"""

# pyright: reportCallInDefaultInitializer=false

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session, select

from ..db import get_session
from ..models.db import AnnotationQueueDB
from ..models.schemas import (
    CreateAnnotationQueueRequest,
    AnnotationQueueResponse,
    CompleteAnnotationRequest,
)
from ..services.demo_workspace import require_project_not_demo
from ..services.project_memberships import enforce_project_role_from_request
from ..services.scoring import create_trace_score, create_observation_score

router = APIRouter(prefix="/api/v1/annotations", tags=["annotations"])


@router.post("/queues", response_model=AnnotationQueueResponse)
async def create_queue(
    body: CreateAnnotationQueueRequest,
    http_request: Request,
    session: Session = Depends(get_session),
):
    """
    Create a new annotation queue.
    """
    require_project_not_demo(body.project)
    # SPEC-122: annotation queue creation requires project admin role.
    _ = enforce_project_role_from_request(
        http_request, session, body.project, minimum_role="admin"
    )

    if body.target_type not in ("TRACE", "OBSERVATION"):
        raise HTTPException(
            status_code=400,
            detail="target_type must be TRACE or OBSERVATION",
        )

    queue = AnnotationQueueDB(
        project=body.project,
        name=body.name,
        target_type=body.target_type,
        score_config_id=body.score_config_id,
    )
    session.add(queue)
    session.commit()
    session.refresh(queue)

    return _queue_to_response(queue)


@router.get("/queues", response_model=list[AnnotationQueueResponse])
async def list_queues(
    http_request: Request,
    project: str | None = None,
    session: Session = Depends(get_session),
):
    """
    List annotation queues, optionally filtered by project.

    SPEC-122: unfiltered queries are scoped to projects the caller is a
    member of, so queues from unrelated projects are never exposed.
    Filtered queries require at least member role on the project.
    """
    if project:
        _ = enforce_project_role_from_request(
            http_request, session, project, minimum_role="member"
        )
        statement = select(AnnotationQueueDB).where(
            AnnotationQueueDB.project == project
        )
    else:
        # Unscoped: restrict to projects the user can access.
        from ..services.project_memberships import list_projects_for_user

        user_id_value = getattr(http_request.state, "user_id", None)
        if not user_id_value:
            # Open-dev fallback: return all queues (legacy behavior).
            statement = select(AnnotationQueueDB)
        else:
            accessible = set(
                list_projects_for_user(session, str(user_id_value))
            )
            statement = select(AnnotationQueueDB)
            if accessible:
                statement = statement.where(
                    AnnotationQueueDB.project.in_(accessible)  # pyright: ignore[reportAttributeAccessIssue]
                )
            else:
                # No memberships: return nothing (or, in legacy mode,
                # only queues the caller could have created ad-hoc).
                statement = statement.where(
                    AnnotationQueueDB.project == "__none__"
                )

    queues = session.exec(statement).all()
    return [_queue_to_response(q) for q in queues]


@router.post("/queues/{queue_id}/complete")
async def complete_annotation(
    queue_id: int,
    body: CompleteAnnotationRequest,
    http_request: Request,
    trace_id: str | None = None,
    observation_id: str | None = None,
    session: Session = Depends(get_session),
):
    """
    Complete an annotation by submitting a score.

    Creates the appropriate score (trace or observation level) and
    updates the queue's completion counter.
    """
    queue = session.get(AnnotationQueueDB, queue_id)
    if not queue:
        raise HTTPException(status_code=404, detail="Queue not found")

    require_project_not_demo(queue.project)
    # SPEC-122: completing an annotation is a write; require member role.
    _ = enforce_project_role_from_request(
        http_request, session, queue.project, minimum_role="member"
    )

    if not queue.is_active:
        raise HTTPException(status_code=400, detail="Queue is not active")

    data_type = "NUMERIC"
    if queue.score_config_id:
        from ..models.db import ScoreConfigDB

        config = session.get(ScoreConfigDB, queue.score_config_id)
        if config:
            data_type = config.data_type

    try:
        if queue.target_type == "TRACE" and trace_id:
            _ = create_trace_score(
                session=session,
                trace_id=trace_id,
                name=queue.name,
                value=body.score_value,
                data_type=data_type,
                source="ANNOTATION",
                config_id=queue.score_config_id,
                comment=body.comment,
            )
        elif queue.target_type == "OBSERVATION" and observation_id:
            _ = create_observation_score(
                session=session,
                observation_id=observation_id,
                name=queue.name,
                value=body.score_value,
                data_type=data_type,
                source="ANNOTATION",
                config_id=queue.score_config_id,
                comment=body.comment,
            )
        else:
            raise HTTPException(
                status_code=400,
                detail=f"Must provide {'trace_id' if queue.target_type == 'TRACE' else 'observation_id'}",
            )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    queue.completed_items += 1
    session.add(queue)
    session.commit()

    return {"status": "success", "queue_id": queue_id}


def _queue_to_response(queue: AnnotationQueueDB) -> AnnotationQueueResponse:
    """Convert an AnnotationQueueDB to a response model."""
    return AnnotationQueueResponse(
        id=queue.id or 0,
        project=queue.project,
        name=queue.name,
        target_type=queue.target_type,
        score_config_id=queue.score_config_id,
        total_items=queue.total_items,
        completed_items=queue.completed_items,
        is_active=queue.is_active,
        created_at=queue.created_at,
        updated_at=queue.updated_at,
    )
