# pyright: reportAny=false, reportCallInDefaultInitializer=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnknownParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

import json
from datetime import datetime, timezone
from typing import Any, cast
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import asc, delete
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import defer
from sqlmodel import Session, select

from ...db import get_session
from ...auth.deps import require_api_key_scope
from ...models.db import OtlpSpanDB
from ...services.project_memberships import (
    enforce_project_read_from_request,
    enforce_project_role_from_request,
    list_readable_projects_from_request,
)
from ...services.projection_io import hydrate_calls_from_spans
from ...services.trace_search import SpanFilterError, parse_span_filter
from ...services.trace_repository import derive_capabilities
from ...db_helpers import as_column, ensure_utc_datetime
from ...models import (
    AgentTaskRunDB,
    RunDB,
    RunMetricDB,
    LoggedCallDB,
    Run,
    RunMetric,
    RunDetail,
    CreateRunRequest,
    UpdateRunRequest,
    LoggedCall,
    CorrectionRequest,
)
from ...metrics import calculate_and_store_aggregate_metrics
from ...services.demo_workspace import require_project_not_demo, require_run_not_demo
from ...services.filters import split_csv_param
from .bulk_export import BulkExportRequest, export_runs
from ...models.columns import (
    CALL_LIGHT,
    LOGGED_CALL_CREATED_AT_COL,
    LOGGED_CALL_STEP_INDEX_COL,
    RUN_ID_COL,
    RUN_METRIC_PROJECT_COL,
    RUN_PROJECT_COL,
)
from .list_query import (
    PaginatedRunSummary,
    RunListFilters,
    RunListPagination,
    list_run_summaries,
)
from .metrics import calculate_run_metrics_from_calls

router = APIRouter(prefix="/v1/runs", tags=["runs"])


@router.patch("/{run_id}/bookmark")
def toggle_bookmark(run_id: str, http_request: Request, session: Session = Depends(get_session)):
    """Toggle bookmark state for a run."""
    run = require_run_not_demo(session, run_id)
    _ = enforce_project_role_from_request(
        http_request, session, run.project, minimum_role="member"
    )
    run.bookmarked = not run.bookmarked
    session.commit()
    session.refresh(run)

    return {"id": run.id, "bookmarked": run.bookmarked}


@router.post("", response_model=Run)
def create_run(request: CreateRunRequest, http_request: Request, session: Session = Depends(get_session)):
    """Create a trace run header. Project member only; demo excluded."""
    require_project_not_demo(request.project)
    _ = enforce_project_role_from_request(
        http_request, session, request.project, minimum_role="member"
    )
    run_id = str(uuid4())

    run = RunDB(
        id=run_id,
        project=request.project,
        task_id=request.task_id,
        flow_name=request.flow_name,
        version=request.version,
        user_id=request.user_id,
        session_id=request.session_id,
        environment=request.environment,
        external_id=request.external_id,
        tags=request.tags or [],
        run_metadata=request.run_metadata,
        primary_model=request.primary_model,
    )

    session.add(run)
    session.commit()
    session.refresh(run)

    return Run.model_validate(run)


@router.patch("/{run_id}", response_model=Run)
def update_run(
    run_id: str,
    request: UpdateRunRequest,
    http_request: Request,
    session: Session = Depends(get_session),
):
    """Patch run completion state. Marking completion stores duration and
    recalculates aggregate metrics from the run's calls."""
    run = require_run_not_demo(session, run_id)

    _validate_trace_write_access(http_request, session, run_id, run.project)
    # For non-service-token callers, require member on the derived Project —
    # the same floor as the other run writes (bookmark, corrections,
    # custom metrics). Viewers can read traces, never mutate them.
    if getattr(http_request.state, "auth_method", None) != "service_token":
        _ = enforce_project_role_from_request(
            http_request, session, run.project, minimum_role="member"
        )

    if request.completed:
        run.completed_at = datetime.now(timezone.utc)
        if run.created_at:
            duration = (
                ensure_utc_datetime(run.completed_at)
                - ensure_utc_datetime(run.created_at)
            ).total_seconds() * 1000
            run.duration_ms = duration

        aggregate_metrics = calculate_and_store_aggregate_metrics(session, run.id, run.project)
        for metric in aggregate_metrics:
            session.add(metric)

    if request.call_count is not None:
        run.call_count = request.call_count

    session.commit()
    session.refresh(run)

    return Run.model_validate(run)


def _validate_trace_write_access(
    request: Request, session: Session, run_id: str, run_project: str
) -> None:
    if getattr(request.state, "auth_method", None) != "service_token":
        return
    token_project = getattr(request.state, "project", None)
    if token_project != run_project:
        raise HTTPException(status_code=403, detail="Service token project mismatch")
    # The token is a capability for ONE task run, not a Project-wide
    # write pass. The run being patched must be the trace that task run
    # claimed at ingestion.
    token_task_run_id = getattr(request.state, "service_task_run_id", None)
    task_run = (
        session.get(AgentTaskRunDB, token_task_run_id)
        if isinstance(token_task_run_id, str)
        else None
    )
    if task_run is None or task_run.trace_run_id != run_id:
        raise HTTPException(status_code=403, detail="Service token run mismatch")


def _enforce_project_read(request: Request, session: Session, project: str) -> None:
    """Scope a read to a project the caller belongs to.

    The runs/trace read endpoints accept a caller-supplied ``project`` query
    param and filter by it, but previously only checked API-key *scope* — so
    any authenticated user (dashboard or API key) could read another
    project's traces by passing ``?project=<other>``. This mirrors the
    membership enforcement the agent-task-run endpoints already apply.
    Dev/open mode (no ``user_id`` on the request) stays permissive, as the
    membership helper does elsewhere.
    """
    _ = enforce_project_read_from_request(request, session, project)


def _caller_project_scope(request: Request, session: Session) -> list[str] | None:
    """The project ids a caller may read across, or ``None`` for unscoped.

    Returns ``None`` in dev/open mode (no ``user_id`` on the request), where
    the membership system is not active — matching the permissive fallback in
    ``enforce_project_role_from_request``. Otherwise returns exactly the
    projects the caller is a member of, so an unscoped list/aggregate can't
    span tenants.
    """
    return list_readable_projects_from_request(request, session)


@router.get("", response_model=PaginatedRunSummary)
def list_runs(
    http_request: Request,
    project: str | None = None,
    flow_name: str | None = Query(None, description="Comma-separated flow_name list"),
    task_id: str | None = Query(None, description="Comma-separated task id list"),
    page: int = Query(0, ge=0, description="Page number (0-indexed)"),
    page_size: int = Query(
        40, ge=1, le=100, description="Number of items per page (max 100)"
    ),
    environment: str | None = Query(None, description="Comma-separated environment list"),
    session_id: str | None = Query(None, description="Comma-separated session ID list"),
    user_id: str | None = Query(None, description="Comma-separated user ID list"),
    tags: str | None = Query(None, description="Comma-separated tag list"),
    models: str | None = Query(None, description="Comma-separated model list"),
    metric_name: str | None = Query(None, description="Filter by metric name"),
    min_score: float | None = Query(None, description="Minimum metric score"),
    max_score: float | None = Query(None, description="Maximum metric score"),
    search: str | None = Query(None, description="Search by run_id or external_id"),
    service: str | None = Query(None, description="Filter traces by service (any span's resource service.name)"),
    operation: str | None = Query(None, description="Filter traces by span name (exact)"),
    span_text: str | None = Query(None, description="Free text over span names and span attributes (case-insensitive, ASCII)"),
    span_filter: str | None = Query(None, description="JSON array of span predicates: [{\"field\": \"attribute:<key>\", \"op\": \"eq|neq|in|not_in|contains|not_contains|starts_with|ends_with|gt|gte|lt|lte|exists|not_exists\", \"value\": ...}]"),
    min_duration_ms: float | None = None,
    max_duration_ms: float | None = None,
    created_after: str | None = Query(None, description="ISO 8601 datetime"),
    created_before: str | None = Query(None, description="ISO 8601 datetime"),
    sort_by: str | None = Query(None, description="Sort field: created_at, duration_ms, call_count"),
    sort_order: str | None = Query("desc", description="Sort direction: asc or desc"),
    status: str | None = Query(None, description="Comma-separated status list: success, warning, error"),
    bookmarked: bool | None = Query(None, description="Filter bookmarked traces"),
    session: Session = Depends(get_session),
    _: None = Depends(require_api_key_scope("full")),
):
    """List run summaries with rich filters (flow, task, tags, models, span
    search) and pagination. Scoped to the caller's readable Projects;
    invalid ``span_filter`` JSON gets 400."""
    # Auth: pin to one project (membership-checked) or restrict to the caller's
    # readable projects. Dev/open mode (no user_id) stays unscoped.
    if project:
        _enforce_project_read(http_request, session, project)
        allowed_projects: list[str] | None = None
    else:
        allowed_projects = _caller_project_scope(http_request, session)

    try:
        span_predicates = parse_span_filter(span_filter)
    except SpanFilterError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return list_run_summaries(
        session,
        RunListFilters(
            project=project,
            allowed_projects=allowed_projects,
            flow_names=split_csv_param(flow_name),
            task_ids=split_csv_param(task_id),
            environments=split_csv_param(environment),
            session_ids=split_csv_param(session_id),
            user_ids=split_csv_param(user_id),
            models=split_csv_param(models),
            tags=tags,
            search=search,
            service=service,
            operation=operation,
            span_text=span_text,
            span_predicates=span_predicates,
            metric_name=metric_name,
            min_score=min_score,
            max_score=max_score,
            min_duration_ms=min_duration_ms,
            max_duration_ms=max_duration_ms,
            created_after=created_after,
            created_before=created_before,
            status_values=split_csv_param(status),
            bookmarked=bookmarked,
        ),
        RunListPagination(
            page=page, page_size=page_size, sort_by=sort_by, sort_order=sort_order
        ),
    )


# The distinct-* endpoints power the dashboard's global filter dropdowns and
# previously scanned every tenant's rows unscoped, leaking the full list of
# project names, task ids, models, and metric names to any authenticated
# caller. They now aggregate only over the caller's own projects (unscoped in
# dev/open mode, where the membership system is inactive).


@router.get("/distinct-projects")
def get_distinct_projects(
    http_request: Request, session: Session = Depends(get_session)
):
    """Distinct project names for filter dropdowns, limited to the caller's
    readable Projects (all projects in dev/open mode)."""
    allowed = _caller_project_scope(http_request, session)
    if allowed is not None:
        return sorted(allowed)
    # session.exec(select(col)) yields scalars, so index [0] would return the
    # first character of each name — return the values themselves.
    return list(session.exec(select(RunDB.project).distinct()).all())


@router.get("/distinct-tasks")
def get_distinct_tasks(
    http_request: Request, session: Session = Depends(get_session)
):
    """Distinct task ids for filter dropdowns, scoped to the caller's
    readable Projects."""
    allowed = _caller_project_scope(http_request, session)
    statement = select(RunDB.task_id).distinct().where(RunDB.task_id != None)
    if allowed is not None:
        statement = statement.where(RUN_PROJECT_COL.in_(allowed))
    tasks = session.exec(statement).all()
    return [task_id for task_id in tasks if task_id is not None]


@router.get("/distinct-models")
def get_distinct_models(
    http_request: Request, session: Session = Depends(get_session)
):
    """Distinct primary model names for filter dropdowns, scoped to the
    caller's readable Projects."""
    allowed = _caller_project_scope(http_request, session)
    statement = (
        select(RunDB.primary_model).distinct().where(RunDB.primary_model != None)
    )
    if allowed is not None:
        statement = statement.where(RUN_PROJECT_COL.in_(allowed))
    models = session.exec(statement).all()
    return [model for model in models if model is not None]


@router.get("/distinct-metrics")
def get_distinct_metrics(
    http_request: Request, session: Session = Depends(get_session)
):
    """Distinct metric names for filter dropdowns, scoped to the caller's
    readable Projects."""
    allowed = _caller_project_scope(http_request, session)
    statement = select(RunMetricDB.metric_name).distinct()
    if allowed is not None:
        statement = statement.where(RUN_METRIC_PROJECT_COL.in_(allowed))
    # Scalars, not rows — see get_distinct_projects.
    return list(session.exec(statement).all())


@router.get("/{run_id}")
def get_run_details(
    run_id: str,
    http_request: Request,
    project: str = "default",
    include: str | None = Query(default=None),
    slim: bool = Query(default=False, description="Ship call metadata only: input/output/tool payloads are omitted (first/last calls carry short previews) so agentic traces don't serialize megabytes of accumulated history. Fetch GET /v1/runs/{run_id}/calls/{call_id} for a single call's full payload."),
    session: Session = Depends(get_session),
    _: None = Depends(require_api_key_scope("full")),
):
    """Full trace detail for one run: calls (messages deferred unless
    ``?include=messages``), stored + derived metrics, derived status, and
    projection capabilities. ``?include=attributes`` attaches canonical
    OTLP span attributes per call. ``?slim=true`` defers every call's
    heavy I/O columns (the dashboard's mode) — the response carries a
    ``slim_calls: true`` marker instead."""
    _enforce_project_read(http_request, session, project)
    run = session.exec(
        select(RunDB).where(RunDB.id == run_id, RunDB.project == project)
    ).first()
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    # `?include=messages` needs the heavy columns anyway — slim only applies
    # to the metadata-only shape.
    effective_slim = slim and not (include and "messages" in include)

    calls_query = select(
        LoggedCallDB
    ).where(
        LoggedCallDB.run_id == run_id,
        LoggedCallDB.project == project,
    ).order_by(
        asc(LOGGED_CALL_STEP_INDEX_COL).nulls_last(),
        asc(LOGGED_CALL_CREATED_AT_COL),
    )

    # Issue #142/#143 audit: the trace DETAIL page renders call messages
    # in expand panels, not all at once. Defer the heaviest columns so they
    # lazy-load only when a panel is opened. This cuts the base payload from
    # MB-scale (50-200 calls × full input/output/messages/tool_result) to
    # scalar-level metadata.
    if effective_slim:
        # Slim mode: never even parse the fat columns. Agentic traces repeat
        # the whole accumulated conversation in every generation's input, so
        # the full payload grows quadratically with trace length (measured:
        # 281 calls → 18 MB). Keep cost_breakdown/raw_usage loaded — the
        # costs/tokens tabs aggregate them and they are a few ints per call.
        calls_query = calls_query.options(
            defer(LoggedCallDB.input),  # pyright: ignore[reportArgumentType]
            defer(LoggedCallDB.output),  # pyright: ignore[reportArgumentType]
            defer(LoggedCallDB.messages),  # pyright: ignore[reportArgumentType]
            defer(LoggedCallDB.tool_parameters),  # pyright: ignore[reportArgumentType]
            defer(LoggedCallDB.tool_result),  # pyright: ignore[reportArgumentType]
        )
    elif not (include and "messages" in include):
        calls_query = calls_query.options(*CALL_LIGHT)

    calls = session.exec(calls_query).all()

    # Slim mode: resolve I/O from canonical spans (span-less rows keep
    # their stored columns). In-memory only — nothing is persisted.
    # Skipped in slim mode: re-hydrating would load every span's fat
    # attributes, which is exactly what slim mode exists to avoid. The
    # per-call endpoint hydrates on demand.
    if not effective_slim:
        hydrate_calls_from_spans(session, list(calls))

    stored_metrics = session.exec(
        select(RunMetricDB).where(
            RunMetricDB.run_id == run_id,
            RunMetricDB.project == project,
        )
    ).all()

    aggregate_metrics = calculate_run_metrics_from_calls(list(calls), run_id)

    metrics_dict: dict[str, RunMetricDB] = {}
    for metric in stored_metrics:
        metrics_dict[metric.metric_name] = metric
    for metric in aggregate_metrics:
        metrics_dict[metric.metric_name] = metric

    all_metrics = list(metrics_dict.values())

    # `messages` duplicates content already present in each call's input/output
    # (the projector copies input.messages + output.messages verbatim), which
    # roughly doubles the response for agentic traces. Ship it only on opt-in
    # (?include=messages — the CLI's `traces show --verbose` uses it); the
    # dashboard renders from input/output and never reads it.
    exclude = (
        None
        if include and "messages" in include
        else {"calls": {"__all__": {"messages"}}}
    )

    response: dict[str, Any]
    if effective_slim:
        response = {
            "run": Run.model_validate(run).model_dump(by_alias=True),
            "metrics": [
                RunMetric.model_validate(m).model_dump(by_alias=True)
                for m in all_metrics
            ],
            "calls": [_slim_call_payload(call) for call in calls],
            "slim_calls": True,
        }
        # The trace-level Preview tab falls back to the first call's input /
        # last call's output when the run itself recorded none — give those
        # two slots a bounded preview so the tab keeps working without the
        # full payloads. Two single-row lazy loads, capped in size.
        if calls:
            _attach_slim_previews(
                cast("list[dict[str, object]]", response["calls"]), calls[0], calls[-1]
            )
    else:
        calls_models: list[LoggedCall] = [
            LoggedCall.model_validate(call, from_attributes=True) for call in calls
        ]
        response = RunDetail(
            run=Run.model_validate(run),
            metrics=[RunMetric.model_validate(m) for m in all_metrics],
            calls=calls_models,
        ).model_dump(by_alias=True, exclude=exclude)

    # Same three-valued status the run LIST derives (error/warning/success
    # from call levels) — consumers like `apo traces show` read it, and the
    # Run schema has no stored column to carry it.
    levels = {call.level for call in calls}
    response["run"]["status"] = (
        "error" if "ERROR" in levels else "warning" if "WARNING" in levels else "success"
    )

    # Same capability semantics as the projection snapshot (issue #164 DX
    # ask): let a reader see which evidence categories this trace's
    # projection carries, so an `unsupported` assertion verdict can be told
    # apart from a misbehaving producer. Skipped in slim mode — the messages
    # capability would require loading every generation's output, which is
    # the work slim mode exists to avoid.
    if not effective_slim:
        response["capabilities"] = derive_capabilities(list(calls), run).model_dump(
            mode="json", by_alias=True
        )

    # `?include=attributes` attaches each call's canonical OtlpSpanDB
    # attributes (issue #164 DX ask) so a producer can verify its OTLP
    # attributes arrived and what they normalized to. Calls ingested through
    # paths that store no canonical span simply carry no `attributes` key.
    if include and "attributes" in include:
        spans = session.exec(
            select(OtlpSpanDB).where(
                OtlpSpanDB.trace_id == run_id,
                OtlpSpanDB.project_id == project,
            )
        ).all()
        attrs_by_span = {s.span_id: s.attributes for s in spans if s.attributes}
        for call in cast(list[dict[str, object]], response["calls"]):
            raw = attrs_by_span.get(str(call["id"]))
            if raw is not None:
                call["attributes"] = raw

    return response


# Preview budget for a slim call's first/last slots — large enough that the
# trace-level Preview tab stays readable, small enough that two of them never
# matter next to the megabytes they stand in for.
_SLIM_PREVIEW_CHARS = 8000


def _slim_call_payload(call: LoggedCallDB) -> dict[str, object]:
    """Serialize a call from its LOADED columns only.

    The heavy I/O columns are deferred in slim mode; touching them (directly
    or via ``LoggedCall.model_validate``) would lazy-load every row, which is
    the exact cost slim mode avoids. Unloaded keys are simply absent from the
    payload. ``meta`` keeps its response alias ``metadata``.
    """
    state = sa_inspect(call)
    if state is None or state.mapper is None:  # defensive; persistent instances always inspect
        raise ValueError(f"call {call.id} is not a persistent instance")
    unloaded = state.unloaded
    payload: dict[str, object] = {}
    for attr in state.mapper.column_attrs:
        if attr.key in unloaded:
            continue
        key = "metadata" if attr.key == "meta" else attr.key
        payload[key] = getattr(call, attr.key)
    return payload


def _slim_preview(value: object) -> str | None:
    if value is None:
        return None
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    if len(text) <= _SLIM_PREVIEW_CHARS:
        return text
    return text[:_SLIM_PREVIEW_CHARS] + "..."


def _attach_slim_previews(
    payloads: list[dict[str, object]], first: LoggedCallDB, last: LoggedCallDB
) -> None:
    """Give the trace Preview tab its two fallback slots (first call input,
    last call output) as bounded strings. The attribute access lazy-loads
    those two rows' fat columns — a deliberate, bounded exception."""
    first_input = _slim_preview(first.input)
    if first_input is not None and payloads:
        payloads[0]["input"] = first_input
    last_output = _slim_preview(last.output)
    if last_output is not None and payloads:
        payloads[-1]["output"] = last_output


class CustomMetricResult(BaseModel):
    name: str
    score: float
    error: str | None = None


class PostCustomMetricsRequest(BaseModel):
    metrics: list[CustomMetricResult]


@router.post("/{run_id}/custom-metrics")
async def post_custom_metrics(
    run_id: str,
    request: PostCustomMetricsRequest,
    http_request: Request,
    session: Session = Depends(get_session),
):
    """Append API-sourced quality metrics to a run, returning per-metric
    success/error results. Project member only; demo excluded."""
    _run = require_run_not_demo(session, run_id)
    _ = enforce_project_role_from_request(
        http_request, session, _run.project, minimum_role="member"
    )

    results_count = 0
    errors: list[dict[str, str]] = []
    for metric_result in request.metrics:
        try:
            metric_db = RunMetricDB(
                run_id=run_id,
                # Stamp the derived Project — the column default
                # would silently file the metric under "default".
                project=_run.project,
                metric_name=metric_result.name,
                metric_type="quality",
                score=metric_result.score,
                data_type="NUMERIC",
                source="API",
                reasoning=None
                if not metric_result.error
                else f"Error: {metric_result.error}",
                meta={"sdk_custom": True, "error": metric_result.error}
                if metric_result.error
                else {"sdk_custom": True},
            )
            session.add(metric_db)
            results_count += 1
        except Exception as e:
            errors.append({"name": metric_result.name, "error": str(e)})

    session.commit()

    return {
        "status": "success" if not errors else "partial",
        "run_id": run_id,
        "metrics_stored": results_count,
        "errors": errors if errors else None,
    }


@router.get("/{run_id}/calls/{call_id}")
def get_call_details(
    run_id: str,
    call_id: str,
    http_request: Request,
    project: str = "default",
    include: str | None = Query(
        default=None, description="'messages' ships the recorded messages array too"
    ),
    session: Session = Depends(get_session),
    _: None = Depends(require_api_key_scope("full")),
):
    """Full payload for ONE call of a run — the on-demand companion of
    ``GET /v1/runs/{run_id}?slim=true``. Returns the call's complete
    input/output/tool payloads (messages only with ``?include=messages``).
    404 when the call does not exist or belongs to another run/project."""
    _enforce_project_read(http_request, session, project)
    call = session.exec(
        select(LoggedCallDB).where(
            LoggedCallDB.id == call_id, LoggedCallDB.project == project
        )
    ).first()
    if not call or call.run_id != run_id:
        raise HTTPException(status_code=404, detail="Call not found")

    # Same slim-write-mode hydration as the run-detail read path: span-backed
    # calls resolve their I/O from canonical spans, in memory.
    hydrate_calls_from_spans(session, [call])

    exclude = None if include and "messages" in include else {"messages"}
    return LoggedCall.model_validate(call, from_attributes=True).model_dump(
        by_alias=True, exclude=exclude
    )


@router.patch("/{run_id}/calls/{call_id}/correction")
def set_corrected_output(
    run_id: str,
    call_id: str,
    request: CorrectionRequest,
    http_request: Request,
    project: str = "default",
    session: Session = Depends(get_session),
):
    """Set or clear the corrected output for a call."""
    _ = enforce_project_role_from_request(
        http_request, session, project, minimum_role="member"
    )
    _run = require_run_not_demo(session, run_id, project)
    call = session.exec(
        select(LoggedCallDB).where(
            LoggedCallDB.id == call_id, LoggedCallDB.project == project
        )
    ).first()
    if not call:
        raise HTTPException(status_code=404, detail="Call not found")
    if call.run_id != run_id:
        raise HTTPException(status_code=400, detail="Call does not belong to this run")

    call.corrected_output = request.corrected_output
    session.commit()
    session.refresh(call)

    return {"id": call.id, "corrected_output": call.corrected_output}


class BulkDeleteRequest(BaseModel):
    run_ids: list[str]


@router.post("/bulk-delete")
def bulk_delete_runs(
    request: BulkDeleteRequest,
    http_request: Request,
    project: str = "default",
    session: Session = Depends(get_session),
):
    """Delete runs and their metrics/calls in one Project. Admin only; 404 if
    any requested id is missing from the Project. Cascade deletes are scoped
    by Project so shared OTel ids can't cross tenants."""
    # Require admin for bulk destructive operations.
    enforce_project_role_from_request(http_request, session, project, minimum_role="admin")
    if not request.run_ids:
        raise HTTPException(status_code=400, detail="No run IDs provided")

    existing_runs = session.exec(
        select(RunDB).where(
            RUN_ID_COL.in_(request.run_ids), RUN_PROJECT_COL == project
        )
    ).all()

    run_id_map = {r.id: r for r in existing_runs}
    missing_run_ids = set(request.run_ids) - set(run_id_map)

    if missing_run_ids:
        raise HTTPException(
            status_code=404, detail=f"Runs not found: {', '.join(missing_run_ids)}"
        )

    for run in existing_runs:
        require_project_not_demo(run.project)

    # Scope cascade deletes by project so a shared OTel id cannot delete another
    # project's metrics/calls.
    deleted_metrics = session.exec(
        delete(RunMetricDB).where(
            as_column(cast(object, RunMetricDB.run_id)).in_(request.run_ids),
            as_column(cast(object, RunMetricDB.project)) == project,
        )
    )

    deleted_calls = session.exec(
        delete(LoggedCallDB).where(
            as_column(cast(object, LoggedCallDB.run_id)).in_(request.run_ids),
            as_column(cast(object, LoggedCallDB.project)) == project,
        )
    )

    _ = session.exec(
        delete(RunDB).where(RUN_ID_COL.in_(request.run_ids), RUN_PROJECT_COL == project)
    )

    session.commit()

    return {
        "deleted_runs": len(request.run_ids),
        "deleted_metrics": deleted_metrics.rowcount if deleted_metrics else 0,
        "deleted_calls": deleted_calls.rowcount if deleted_calls else 0,
    }


@router.post("/bulk-export")
def bulk_export_runs(
    request: BulkExportRequest,
    http_request: Request,
    project: str = "default",
    session: Session = Depends(get_session),
):
    """Export runs in the requested format. Requires member read on the
    target Project."""
    # Require member on the target Project.
    enforce_project_read_from_request(http_request, session, project)
    return export_runs(session, request.run_ids, project, request.format)


# ── Replay / re-projection ─────────────────────────


@router.post("/{run_id}/reproject")
def reproject_run(
    run_id: str,
    http_request: Request,
    project: str = "default",
    session: Session = Depends(get_session),
):
    """Re-project a trace's canonical spans through the normalizer.

    Reads canonical spans from ``OtlpSpanDB`` and re-projects them into
    ``RunDB`` / ``LoggedCallDB``. Use this after a mapper change to update
    the product tables without re-ingesting the raw payload.

    Criterion #2: "The same raw canonical span can be replayed to
    produce a new Trace Projection after a mapper change."

    The ``project`` query parameter specifies which project the trace belongs
    to (required because canonical spans are scoped by project).
    """
    _ = enforce_project_role_from_request(
        http_request, session, project, minimum_role="member"
    )
    from ...models.db import OtlpSpanDB as _OtlpSpanDB
    from ...services.reproject import reproject_trace

    # Resolve the canonical span scoped by ``(trace_id, project)`` so two
    # projects sharing an OTel id each re-project their own trace.
    canonical = session.exec(
        select(_OtlpSpanDB).where(
            _OtlpSpanDB.trace_id == run_id, _OtlpSpanDB.project_id == project
        ).limit(1)
    ).first()
    if canonical is None:
        raise HTTPException(status_code=404, detail="Trace not found in canonical store")

    count = reproject_trace(run_id, project_id=project)
    return {"trace_id": run_id, "project": project, "reprojected_spans": count}
