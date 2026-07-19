"""
Score management API for observation-level and trace-level scoring.

Provides endpoints for creating and retrieving scores using existing
CallMetricDB (observation-level) and RunMetricDB (trace-level) models.
"""

# pyright: reportCallInDefaultInitializer=false

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlmodel import Session, select

from ..auth.deps import require_api_key_scope
from ..db import get_session
from ..models.db import CallMetricDB, RunMetricDB, ScoreConfigDB
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


def _project_from_request(http_request: Request) -> str:
    """Read the authenticated Project from the request, defaulting to ``default``.

    Tolerates direct (non-ASGI) calls in tests where ``request.state`` is absent.
    """
    state = getattr(http_request, "state", None)
    if state is None:
        return "default"
    return getattr(state, "project", "default")


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

    Supports API, EVAL, and ANNOTATION score sources.
    """
    project = _project_from_request(http_request)
    _run = require_run_not_demo(session, trace_id, project)
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

    Supports API, EVAL, and ANNOTATION score sources.
    """
    project = _project_from_request(http_request)
    _call = require_call_not_demo(session, obs_id, project)
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
    project: str = "default",
    session: Session = Depends(get_session),
):
    """
    Get all scores for a trace (run-level).

    Returns both quality and aggregate metrics.
    """
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
    project = _project_from_request(http_request)
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
    project: str | None = Query(default=None),
    session: Session = Depends(get_session),
):
    """
    List available score configs.

    Returns non-archived score configs, optionally filtered by project.
    """
    query = select(ScoreConfigDB).where(ScoreConfigDB.is_archived == False)  # noqa: E712
    if project:
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
