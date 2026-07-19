"""
Langfuse-compatible public API endpoints (legacy adapter — SPEC-129).

Provides drop-in replacement endpoints for Langfuse SDK integration. Events
are mirrored into the canonical ``OtlpSpanDB`` store alongside the direct
``RunDB``/``LoggedCallDB`` writes, making this route an adapter over the
canonical path rather than a separate direct writer (SPEC-129 Criterion #7).
"""

# pyright: reportCallInDefaultInitializer=false, reportPrivateUsage=false

from datetime import datetime
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import desc
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import Session, func, select

from ..auth.deps import require_api_key_scope
from ..db import get_session
from ..services.filters import apply_tag_all_filter
from ..services.projection_lookup import select_call, select_run
from ..models.db import (
    CallMetricDB,
    LoggedCallDB,
    RunDB,
    RunMetricDB,
    SessionDB,
)
from ..services.ingestion import (
    process_langfuse_score_create,
)
from ..services.legacy_adapter import (
    ingest_run_create_to_canonical,
    ingest_call_create_to_canonical,
    ingest_call_update_to_canonical,
)
from ..services.langfuse_mapper import (
    langfuse_event_to_internal,
    run_to_langfuse_trace,
    call_to_langfuse_observation,
    metric_to_langfuse_score,
    call_metric_to_langfuse_score,
)

router = APIRouter(prefix="/api/public", tags=["langfuse"])


def _project_from_request(http_request: Request) -> str:
    """Read the authenticated Project from the request, defaulting to ``default``.

    Tolerates direct (non-ASGI) calls in tests where ``request.state`` is absent.
    """
    state = getattr(http_request, "state", None)
    if state is None:
        return "default"
    return getattr(state, "project", "default")


RUN_CREATED_AT_COL: ColumnElement[datetime] = cast(
    ColumnElement[datetime], cast(object, RunDB.created_at)
)
SESSION_CREATED_AT_COL: ColumnElement[datetime] = cast(
    ColumnElement[datetime], cast(object, SessionDB.created_at)
)


class LangfuseIngestionEvent(BaseModel):
    """Single event in a Langfuse SDK batch."""

    id: str
    type: str
    timestamp: datetime
    body: dict[str, object]


class LangfuseBatchRequest(BaseModel):
    """Langfuse SDK batch ingestion format."""

    batch: list[LangfuseIngestionEvent]


class LangfuseIngestionResult(BaseModel):
    """Result for a single event in batch."""

    id: str
    status: int


class LangfusePaginatedResponse(BaseModel):
    """Paginated response wrapper matching Langfuse format."""

    data: list[dict[str, object]]
    meta: dict[str, object]


class CreateScoreRequest(BaseModel):
    """Request to create a score on a trace or observation."""

    traceId: str | None = None
    observationId: str | None = None
    name: str
    value: float
    dataType: str = "NUMERIC"
    source: str = "API"
    comment: str | None = None
    configId: int | None = None


@router.post("/ingestion")
async def langfuse_ingestion(
    request: LangfuseBatchRequest,
    http_request: Request,
    db: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full", "ingest")),
):
    """Accept Langfuse SDK batch ingestion format.

    Maps each event type to our internal format and processes
    using existing ingestion processors.
    """
    project = _project_from_request(http_request)
    results: list[LangfuseIngestionResult] = []

    for event in request.batch:
        try:
            internal = langfuse_event_to_internal(event.type, event.body)
            if internal is None:
                results.append(LangfuseIngestionResult(id=event.id, status=400))
                continue

            event_type = internal["type"]
            body = cast(dict[str, object], internal["body"])

            if event_type == "run-create":
                ingest_run_create_to_canonical(body, db)
            elif event_type == "call-create":
                ingest_call_create_to_canonical(body, db)
            elif event_type == "call-update":
                ingest_call_update_to_canonical(body, db)
            elif event_type == "score-create":
                await process_langfuse_score_create(event.body, db, project)
            else:
                results.append(LangfuseIngestionResult(id=event.id, status=400))
                continue

            results.append(LangfuseIngestionResult(id=event.id, status=200))
        except Exception:
            results.append(LangfuseIngestionResult(id=event.id, status=500))

    db.commit()
    return {"results": [r.model_dump() for r in results]}


@router.get("/traces")
async def list_traces(
    project: str | None = None,
    userId: str | None = None,
    sessionId: str | None = None,
    tags: str | None = Query(None, description="Comma-separated tag list"),
    environment: str | None = None,
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_session),
):
    """List traces with optional filters, returns Langfuse format."""
    statement = select(RunDB)

    if project:
        statement = statement.where(RunDB.project == project)
    if userId:
        statement = statement.where(RunDB.user_id == userId)
    if sessionId:
        statement = statement.where(RunDB.session_id == sessionId)
    if environment:
        statement = statement.where(RunDB.environment == environment)
    if tags:
        tag_list = [t.strip() for t in tags.split(",") if t.strip()]
        statement = apply_tag_all_filter(statement, tag_list)

    total_count = db.exec(select(func.count()).select_from(statement.subquery())).one()

    statement = statement.order_by(desc(RUN_CREATED_AT_COL))
    statement = statement.offset((page - 1) * limit).limit(limit)

    runs = db.exec(statement).all()
    traces = [_build_trace_response(run, db) for run in runs]

    return LangfusePaginatedResponse(
        data=traces,
        meta={
            "page": page,
            "limit": limit,
            "totalItems": total_count,
        },
    )


@router.get("/traces/{trace_id}")
async def get_trace(
    trace_id: str,
    request: Request,
    db: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("read", "ingest")),
):
    """Get a single trace with all observations and scores."""
    project = _project_from_request(request)
    run = select_run(db, trace_id, project)
    if not run:
        raise HTTPException(status_code=404, detail="Trace not found")

    return _build_trace_response(run, db, include_observations=True)


@router.get("/observations")
async def list_observations(
    traceId: str | None = None,
    type: str | None = None,
    model: str | None = None,
    name: str | None = None,
    environment: str | None = None,
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_session),
):
    """List observations (cursor-paginated)."""
    statement = select(LoggedCallDB)

    if traceId:
        statement = statement.where(LoggedCallDB.run_id == traceId)
    if type:
        statement = statement.where(LoggedCallDB.observation_type == type.upper())
    if model:
        statement = statement.where(LoggedCallDB.model == model)
    if name:
        statement = statement.where(LoggedCallDB.step_name == name)
    if environment:
        statement = statement.where(LoggedCallDB.environment == environment)

    total_count = db.exec(select(func.count()).select_from(statement.subquery())).one()

    statement = statement.order_by(
        desc(cast(ColumnElement[datetime], cast(object, LoggedCallDB.created_at)))
    )
    statement = statement.offset((page - 1) * limit).limit(limit)

    calls = db.exec(statement).all()
    observations = [call_to_langfuse_observation(c) for c in calls]

    return LangfusePaginatedResponse(
        data=observations,
        meta={
            "page": page,
            "limit": limit,
            "totalItems": total_count,
        },
    )


@router.post("/scores")
async def create_score(
    request: CreateScoreRequest,
    http_request: Request,
    db: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full", "ingest")),
):
    """Create a score attached to a trace or observation."""
    project = _project_from_request(http_request)
    if request.traceId:
        run = select_run(db, request.traceId, project)
        if not run:
            raise HTTPException(status_code=404, detail="Trace not found")

        metric = RunMetricDB(
            run_id=request.traceId,
            project=project,
            metric_name=request.name,
            metric_type="quality",
            score=request.value,
            data_type=request.dataType,
            source=request.source,
            config_id=request.configId,
            reasoning=request.comment,
        )
        db.add(metric)
        db.commit()
        db.refresh(metric)
        return metric_to_langfuse_score(metric)

    if request.observationId:
        call = select_call(db, request.observationId, project)
        if not call:
            raise HTTPException(status_code=404, detail="Observation not found")

        metric = CallMetricDB(
            call_id=request.observationId,
            project=project,
            metric_name=request.name,
            metric_type="quality",
            score=request.value,
            data_type=request.dataType,
            source=request.source,
            config_id=request.configId,
            reasoning=request.comment,
        )
        db.add(metric)
        db.commit()
        db.refresh(metric)
        return call_metric_to_langfuse_score(metric)

    raise HTTPException(status_code=400, detail="Must provide traceId or observationId")


@router.get("/sessions")
async def list_sessions(
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_session),
):
    """List sessions."""
    statement = select(SessionDB).order_by(desc(SESSION_CREATED_AT_COL))
    statement = statement.offset((page - 1) * limit).limit(limit)

    db_sessions = db.exec(statement).all()

    total_count = db.exec(select(func.count()).select_from(SessionDB)).one()

    session_data: list[dict[str, object]] = [
        {
            "id": s.id,
            "project": s.project,
            "userId": s.user_id,
            "environment": s.environment,
            "tags": s.tags,
            "createdAt": s.created_at.isoformat() if s.created_at else None,
        }
        for s in db_sessions
    ]

    return LangfusePaginatedResponse(
        data=session_data,
        meta={
            "page": page,
            "limit": limit,
            "totalItems": total_count,
        },
    )


@router.get("/sessions/{session_id}")
async def get_session_detail(
    session_id: str,
    db: Session = Depends(get_session),
):
    """Get session with its traces."""
    sess = db.get(SessionDB, session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")

    runs = db.exec(
        select(RunDB)
        .where(RunDB.session_id == session_id)
        .order_by(desc(RUN_CREATED_AT_COL))
    ).all()

    traces = [_build_trace_response(r, db) for r in runs]

    return {
        "id": sess.id,
        "project": sess.project,
        "userId": sess.user_id,
        "environment": sess.environment,
        "tags": sess.tags,
        "createdAt": sess.created_at.isoformat() if sess.created_at else None,
        "traces": traces,
    }


def _build_trace_response(
    run: RunDB,
    db: Session,
    include_observations: bool = False,
) -> dict[str, object]:
    """Build a Langfuse trace response from a RunDB."""
    trace = run_to_langfuse_trace(run)

    if include_observations:
        calls = db.exec(select(LoggedCallDB).where(LoggedCallDB.run_id == run.id)).all()
        trace["observations"] = [call_to_langfuse_observation(c) for c in calls]

        run_metrics = db.exec(
            select(RunMetricDB).where(RunMetricDB.run_id == run.id)
        ).all()
        trace["scores"] = [metric_to_langfuse_score(m) for m in run_metrics]

    return trace
