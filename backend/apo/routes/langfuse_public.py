"""
Langfuse-compatible public API endpoints (legacy adapter).

Provides drop-in replacement endpoints for Langfuse SDK integration. Events
are mirrored into the canonical ``OtlpSpanDB`` store alongside the direct
``RunDB``/``LoggedCallDB`` writes, making this route an adapter over the
canonical path rather than a separate direct writer.
"""

# pyright: reportAny=false, reportCallInDefaultInitializer=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnusedCallResult=false

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
from ..services.projection_io import hydrate_calls_from_spans
from ..services.projection_lookup import select_call, select_run
from ..models.columns import RUN_CREATED_AT_COL, SESSION_CREATED_AT_COL
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
from ..services.project_memberships import (
    authorize_project_request,
    readable_project_ids_for_request,
)
from ..routes.ingestion import (
    authorized_ingestion_project,
    authorized_score_project,
)
from ..services.langfuse_mapper import (
    langfuse_event_to_internal,
    run_to_langfuse_trace,
    call_to_langfuse_observation,
    metric_to_langfuse_score,
    call_metric_to_langfuse_score,
)

router = APIRouter(prefix="/api/public", tags=["langfuse"])


def _credential_bound_project(http_request: Request) -> str | None:
    """The Project bound to a credential, if the request carries one."""
    auth_method = getattr(http_request.state, "auth_method", None)
    if auth_method not in ("api_key", "service_token", "attempt_token"):
        return None
    project = getattr(http_request.state, "project", None)
    return str(project) if project else None


def _langfuse_list_scope(
    http_request: Request, db: Session, project: str | None
) -> list[str] | None:
    """Exact readable Project IDs for a Langfuse list endpoint.

    Credentials are confined to their bound Project (an explicit
    ``project`` query that disagrees is rejected). Sessions authorize an
    explicit Project at member role, or fall back to the readable-Project
    set; ``None`` means open-dev mode (no scope) per the canonical policy.
    """
    bound = _credential_bound_project(http_request)
    if bound is not None:
        if project is not None and project != bound:
            raise HTTPException(status_code=403, detail="Project mismatch")
        return [bound]
    if project is not None:
        _ = authorize_project_request(http_request, db, project, minimum_role="viewer")
        return [project]
    return readable_project_ids_for_request(http_request, db)


def _langfuse_read_project(
    http_request: Request,
    db: Session,
    project_param: str | None,
    trace_id: str,
) -> str:
    """Resolve the single Project a trace read may target.

    OTel trace ids collide across Projects, so a session without an
    explicit ``project`` resolves through the owning rows: the first
    Project that both owns the trace and admits the caller wins. No
    authorized owner → opaque 404.
    """
    bound = _credential_bound_project(http_request)
    if bound is not None:
        if project_param is not None and project_param != bound:
            raise HTTPException(status_code=403, detail="Project mismatch")
        return bound
    if project_param is not None:
        _ = authorize_project_request(http_request, db, project_param, minimum_role="viewer")
        return project_param
    for owner in _trace_owner_projects(db, trace_id):
        try:
            _ = authorize_project_request(http_request, db, owner, minimum_role="viewer")
        except HTTPException:
            continue
        return owner
    raise HTTPException(status_code=404, detail="Trace not found")


def _trace_owner_projects(db: Session, trace_id: str) -> list[str]:
    runs = db.exec(select(RunDB).where(RunDB.id == trace_id)).all()
    return [run.project for run in runs]


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
    using existing ingestion processors. Every event is written to the
    route-authorized Project (credential binding or session membership) —
    a body Project never authorizes the write.
    """
    # Ingest guardrails — BEFORE the per-event loop (per-event except
    # blocks would swallow enforcement into 200-with-errors).
    from ..services.ingest_quota import enforce_ingest_guardrails, record_ingest_usage

    enforce_ingest_guardrails(http_request, db, pending_spans=len(request.batch))

    results: list[LangfuseIngestionResult] = []

    for event in request.batch:
        try:
            if event.type == "score-create":
                project = authorized_score_project(
                    http_request,
                    db,
                    trace_id=_optional_str(event.body.get("traceId")),
                    observation_id=_optional_str(event.body.get("observationId")),
                )
                await process_langfuse_score_create(event.body, db, project)
                results.append(LangfuseIngestionResult(id=event.id, status=200))
                continue

            internal = langfuse_event_to_internal(event.type, event.body)
            if internal is None:
                results.append(LangfuseIngestionResult(id=event.id, status=400))
                continue

            event_type = internal["type"]
            body = cast(dict[str, object], internal["body"])

            project = authorized_ingestion_project(
                http_request, db, _optional_str(body.get("project"))
            )

            if event_type == "run-create":
                ingest_run_create_to_canonical(body, db, project)
            elif event_type == "call-create":
                ingest_call_create_to_canonical(body, db, project)
            elif event_type == "call-update":
                ingest_call_update_to_canonical(body, db, project)
            else:
                results.append(LangfuseIngestionResult(id=event.id, status=400))
                continue

            results.append(LangfuseIngestionResult(id=event.id, status=200))
        except Exception:
            results.append(LangfuseIngestionResult(id=event.id, status=500))

    db.commit()

    record_ingest_usage(
        db,
        getattr(http_request.state, "api_key_id", None),
        spans=sum(1 for r in results if r.status == 200),
        bytes_=0,
    )
    return {"results": [r.model_dump() for r in results]}


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


@router.get("/traces")
async def list_traces(
    http_request: Request,
    project: str | None = None,
    userId: str | None = None,
    sessionId: str | None = None,
    tags: str | None = Query(None, description="Comma-separated tag list"),
    environment: str | None = None,
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_session),
):
    """List traces with optional filters, returns Langfuse format.

    The result is constrained to the caller's readable Projects; an
    unscoped request never returns every tenant's rows.
    """
    allowed = _langfuse_list_scope(http_request, db, project)
    if allowed is not None and not allowed:
        return LangfusePaginatedResponse(data=[], meta=_empty_meta(page, limit))

    statement = select(RunDB)
    if allowed is not None:
        statement = statement.where(RunDB.project.in_(allowed))  # pyright: ignore[reportAttributeAccessIssue]
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
    project: str | None = None,
    _: object = Depends(require_api_key_scope("read", "ingest")),
):
    """Get a single trace with all observations and scores."""
    resolved_project = _langfuse_read_project(request, db, project, trace_id)
    run = select_run(db, trace_id, resolved_project)
    if not run:
        raise HTTPException(status_code=404, detail="Trace not found")

    return _build_trace_response(run, db, include_observations=True)


@router.get("/observations")
async def list_observations(
    http_request: Request,
    traceId: str | None = None,
    type: str | None = None,
    model: str | None = None,
    name: str | None = None,
    environment: str | None = None,
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_session),
):
    """List observations (cursor-paginated), readable-Project scoped."""
    allowed = _langfuse_list_scope(http_request, db, None)
    if allowed is not None and not allowed:
        return LangfusePaginatedResponse(data=[], meta=_empty_meta(page, limit))

    statement = select(LoggedCallDB)
    if allowed is not None:
        statement = statement.where(LoggedCallDB.project.in_(allowed))  # pyright: ignore[reportAttributeAccessIssue]

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
    hydrate_calls_from_spans(db, list(calls))
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
    try:
        project = authorized_score_project(
            http_request,
            db,
            trace_id=request.traceId,
            observation_id=request.observationId,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
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
    http_request: Request,
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_session),
):
    """List sessions, readable-Project scoped."""
    allowed = _langfuse_list_scope(http_request, db, None)
    if allowed is not None and not allowed:
        return LangfusePaginatedResponse(data=[], meta=_empty_meta(page, limit))

    statement = select(SessionDB)
    if allowed is not None:
        statement = statement.where(SessionDB.project.in_(allowed))  # pyright: ignore[reportAttributeAccessIssue]
    statement = statement.order_by(desc(SESSION_CREATED_AT_COL))
    statement = statement.offset((page - 1) * limit).limit(limit)

    db_sessions = db.exec(statement).all()

    total_count = db.exec(select(func.count()).select_from(statement.subquery())).one()

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
    http_request: Request,
    db: Session = Depends(get_session),
):
    """Get session with its traces (readable-Project scoped, opaque 404)."""
    sess = db.get(SessionDB, session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")

    allowed = _langfuse_list_scope(http_request, db, None)
    if allowed is not None and sess.project not in allowed:
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


def _empty_meta(page: int, limit: int) -> dict[str, object]:
    return {"page": page, "limit": limit, "totalItems": 0}


def _build_trace_response(
    run: RunDB,
    db: Session,
    include_observations: bool = False,
) -> dict[str, object]:
    """Build a Langfuse trace response from a RunDB.

    Observations and scores are fetched with a Project predicate: OTel ids
    collide across Projects, so an unpinned ``run_id`` lookup would merge
    another tenant's rows into this trace.
    """
    trace = run_to_langfuse_trace(run)

    if include_observations:
        calls = db.exec(
            select(LoggedCallDB).where(
                LoggedCallDB.run_id == run.id,
                LoggedCallDB.project == run.project,
            )
        ).all()
        hydrate_calls_from_spans(db, list(calls))
        trace["observations"] = [call_to_langfuse_observation(c) for c in calls]

        run_metrics = db.exec(
            select(RunMetricDB).where(
                RunMetricDB.run_id == run.id,
                RunMetricDB.project == run.project,
            )
        ).all()
        trace["scores"] = [metric_to_langfuse_score(m) for m in run_metrics]

    return trace
