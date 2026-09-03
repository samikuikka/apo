"""
Score management API for observation-level and trace-level scoring.

Provides endpoints for creating and retrieving scores using existing
CallMetricDB (observation-level) and RunMetricDB (trace-level) models.
"""

# pyright: reportAny=false, reportCallInDefaultInitializer=false, reportUnusedCallResult=false

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..services.project_memberships import (
    authorize_project_request,
    enforce_project_read_from_request,
    readable_project_ids_for_request,
)
from sqlmodel import Session, col, select

from ..auth.deps import require_api_key_scope
from ..db import get_session
from ..models.db import CallMetricDB, LoggedCallDB, RunDB, RunMetricDB, ScoreConfigDB
from ..models.schemas import (
    CreateScoreRequest,
    ScoreResponse,
    BulkScoreRequest,
    BulkScoreResponse,
    ScoreConfigResponse,
)
from ..services.demo_workspace import require_call_not_demo, require_run_not_demo
from ..services.scoring import (
    create_trace_score,
    create_observation_score,
    get_scores_for_trace,
)

router = APIRouter(prefix="/api/v1", tags=["scores"])


def _credential_project(http_request: Request) -> str | None:
    """The Project bound to a credential (API key / service / Attempt token).

    Cookie sessions carry no Project — ``None`` tells the caller to derive
    the Project from the target instead (the literal ``default`` fallback
    was never authority).
    """
    state = getattr(http_request, "state", None)
    if state is None:
        return None
    project = getattr(state, "project", None)
    return str(project) if project else None


def _session_score_project(
    http_request: Request,
    session: Session,
    candidate_projects: list[str],
) -> str:
    """Authorize a session/open-dev score write against the target's Project.

    Trace/observation IDs are public OTel identifiers and can collide across
    Projects, so every Project owning the ID is a candidate; the first one
    the caller is a member of wins. No authorized candidate → 404 (opaque).
    """
    for project in candidate_projects:
        try:
            _ = authorize_project_request(
                http_request, session, project, minimum_role="member"
            )
        except HTTPException:
            continue
        return project
    raise HTTPException(status_code=404, detail="Run not found")


def _run_candidate_projects(session: Session, trace_id: str) -> list[str]:
    """Projects that own a run with this public trace ID."""
    runs = session.exec(select(RunDB).where(RunDB.id == trace_id)).all()
    return [run.project for run in runs]


def _call_candidate_projects(session: Session, obs_id: str) -> list[str]:
    """Projects that own a logged call with this public observation ID."""
    calls = session.exec(select(LoggedCallDB).where(LoggedCallDB.id == obs_id)).all()
    return [call.project for call in calls]


@router.post("/traces/{trace_id}/scores", response_model=ScoreResponse)
async def create_trace_score_endpoint(
    trace_id: str,
    request: CreateScoreRequest,
    http_request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full", "ingest")),
):
    """
    Create a score for a trace (run-level).

    Supports API and EVAL score sources.
    """
    credential_project = _credential_project(http_request)
    if credential_project is not None:
        project = credential_project
        _run = require_run_not_demo(session, trace_id, project)
    else:
        # Session / open-dev: the Project comes from the target run's
        # durable ownership and the caller must be a member.
        project = _session_score_project(
            http_request, session, _run_candidate_projects(session, trace_id)
        )
    try:
        metric = create_trace_score(
            session=session,
            trace_id=trace_id,
            name=request.name,
            value=request.value,
            project=project,
            data_type=request.data_type,
            source=request.source,
            config_id=request.config_id,
            comment=request.comment,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return _metric_to_score_response(metric, trace_id=trace_id)


@router.post("/observations/{obs_id}/scores", response_model=ScoreResponse)
async def create_observation_score_endpoint(
    obs_id: str,
    request: CreateScoreRequest,
    http_request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full", "ingest")),
):
    """
    Create a score for an observation (call/span level).

    Supports API and EVAL score sources.
    """
    credential_project = _credential_project(http_request)
    if credential_project is not None:
        project = credential_project
        _call = require_call_not_demo(session, obs_id, project)
    else:
        # Session / open-dev: the Project comes from the target call's
        # durable ownership and the caller must be a member.
        project = _session_score_project(
            http_request, session, _call_candidate_projects(session, obs_id)
        )
    try:
        metric = create_observation_score(
            session=session,
            observation_id=obs_id,
            name=request.name,
            value=request.value,
            project=project,
            data_type=request.data_type,
            source=request.source,
            config_id=request.config_id,
            comment=request.comment,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return _metric_to_score_response(metric, observation_id=obs_id)


@router.get("/traces/{trace_id}/scores", response_model=list[ScoreResponse])
async def get_trace_scores(
    trace_id: str,
    request: Request,
    project: str = "default",
    session: Session = Depends(get_session),
):
    """
    Get all scores for a trace (run-level).

    Returns both quality and aggregate metrics.
    """
    # Require readable Project membership.
    enforce_project_read_from_request(request, session, project)
    metrics = get_scores_for_trace(session, trace_id, project)
    return [_metric_to_score_response(m, trace_id=trace_id) for m in metrics]


@router.post("/scores/bulk", response_model=BulkScoreResponse)
async def create_bulk_scores(
    request: BulkScoreRequest,
    http_request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full", "ingest")),
):
    """
    Create multiple scores at once.

    Supports both trace-level and observation-level scores.
    Partial failures are reported - successful scores are still created.
    """
    credential_project = _credential_project(http_request)
    if credential_project is not None:
        project = credential_project
    else:
        # Session / open-dev: derive the Project from the target's durable
        # ownership and require membership.
        if request.observation_id:
            candidates = _call_candidate_projects(session, request.observation_id)
        else:
            candidates = _run_candidate_projects(session, request.trace_id or "")
        project = _session_score_project(http_request, session, candidates)
    created = 0
    errors: list[str] = []

    for i, score_req in enumerate(request.scores):
        trace_id = request.trace_id
        obs_id = request.observation_id

        try:
            if obs_id:
                _call = require_call_not_demo(session, obs_id, project)
                _ = create_observation_score(
                    session=session,
                    observation_id=obs_id,
                    name=score_req.name,
                    value=score_req.value,
                    project=project,
                    data_type=score_req.data_type,
                    source=score_req.source,
                    config_id=score_req.config_id,
                    comment=score_req.comment,
                )
            elif trace_id:
                _run = require_run_not_demo(session, trace_id, project)
                _ = create_trace_score(
                    session=session,
                    trace_id=trace_id,
                    name=score_req.name,
                    value=score_req.value,
                    project=project,
                    data_type=score_req.data_type,
                    source=score_req.source,
                    config_id=score_req.config_id,
                    comment=score_req.comment,
                )
            else:
                errors.append(f"Score {i}: no trace_id or observation_id provided")
                continue
            created += 1
        except Exception as e:
            errors.append(f"Score {i} ({score_req.name}): {str(e)}")

    return BulkScoreResponse(created=created, errors=errors)


@router.get("/score-configs", response_model=list[ScoreConfigResponse])
async def list_score_configs(
    request: Request,
    project: str | None = Query(default=None),
    session: Session = Depends(get_session),
):
    """
    List available score configs.

    Returns non-archived score configs, optionally filtered by project.
    """
    # Scope by readable Projects.
    if project:
        enforce_project_read_from_request(request, session, project)
        project_ids: list[str] | None = [project]
    else:
        project_ids = readable_project_ids_for_request(request, session)

    query = select(ScoreConfigDB).where(ScoreConfigDB.is_archived == False)  # noqa: E712
    if project_ids is not None:
        query = query.where(col(ScoreConfigDB.project).in_(project_ids))
    elif project:
        query = query.where(ScoreConfigDB.project == project)
    configs = session.exec(query).all()
    return [
        ScoreConfigResponse(
            id=c.id or 0,
            name=c.name,
            data_type=c.data_type,
            min_value=c.min_value,
            max_value=c.max_value,
            categories=c.categories,
            description=c.description,
            is_archived=c.is_archived,
        )
        for c in configs
    ]


def _metric_to_score_response(
    metric: RunMetricDB | CallMetricDB,
    trace_id: str | None = None,
    observation_id: str | None = None,
) -> ScoreResponse:
    """Convert a metric DB object to a ScoreResponse."""
    return ScoreResponse(
        id=metric.id or 0,
        trace_id=trace_id,
        observation_id=observation_id,
        name=metric.metric_name,
        value=metric.score,
        string_value=metric.string_value,
        data_type=metric.data_type,
        source=metric.source,
        config_id=metric.config_id,
        comment=metric.reasoning,
        created_at=metric.created_at,
    )
