"""Task-Run-scoped Trace Projection read endpoint (SPEC-130 Track B).

``GET /v1/agent-task-runs/{task_run_id}/trace-projection``

An internal execution boundary: the agent-task runner polls this after
flushing its execution Trace to read back the immutable projection snapshot it
will evaluate against. It is NOT the dashboard's canonical Trace detail API.

Security (SPEC-130 §Task-Run-scoped projection endpoint):
  - The service-token subject MUST equal ``{task_run_id}``.
  - Project comes from the verified token (``request.state.project``), never
    query parameters or telemetry.
  - The route resolves the Trace through ``AgentTaskRunDB.trace_run_id``;
    callers cannot supply or read an arbitrary Trace ID.
  - The narrow ``trace:read-own`` permission is required (added in Track B).

Responses:
  200 — claimed Trace completely projected -> ``TraceProjectionSnapshot``
  202 — claim/export/projection not ready -> ``{"status":"pending"}`` + Retry-After
  403 — token subject or Project does not own this Task Run
  404 — Task Run does not exist in the token's Project
  409 — Task Run completed without a Trace claim
"""

# pyright: reportCallInDefaultInitializer=false

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlmodel import Session, col, select

from ..db import get_session
from ..models.db import AgentTaskBatchRunDB, AgentTaskRunDB
from ..models.trace_projection import TraceProjectionSnapshot
from ..services.trace_repository import get_trace_repository

router = APIRouter(prefix="/v1", tags=["agent-tasks"])

# Bounded backoff hint for a not-yet-projected trace. The SDK reader applies
# its own exponential backoff up to a configurable deadline; this just seeds
# the first retry interval.
_RETRY_AFTER_SECONDS = "2"


def _require_service_token(request: Request) -> tuple[str, str]:
    """Return (project, task_run_id) from the verified service token.

    Raises 403 if the caller is not a service token — only task-run service
    tokens may read projections. (Browser/cookie consumers use the existing
    Trace APIs.)
    """
    if getattr(request.state, "auth_method", None) != "service_token":
        raise HTTPException(status_code=403, detail="Not authorized for this task run")
    project = getattr(request.state, "project", None)
    task_run_id = getattr(request.state, "service_task_run_id", None)
    if not isinstance(project, str) or not isinstance(task_run_id, str):
        raise HTTPException(status_code=403, detail="Not authorized for this task run")
    return project, task_run_id


def _load_task_run(
    session: Session,
    *,
    project: str,
    task_run_id: str,
) -> AgentTaskRunDB:
    """Load a task run scoped to the token's project (via its batch run).

    Raises 404 if the task run does not exist in that project.
    """
    stmt = (
        select(AgentTaskRunDB)
        .join(AgentTaskBatchRunDB)
        .where(
            col(AgentTaskRunDB.id) == task_run_id,
            col(AgentTaskBatchRunDB.project) == project,
        )
    )
    task_run = session.exec(stmt).first()
    if task_run is None:
        raise HTTPException(status_code=404, detail="Task run not found")
    return task_run


@router.get(
    "/agent-task-runs/{task_run_id}/trace-projection",
    response_model=TraceProjectionSnapshot,
)
async def get_task_run_trace_projection(
    task_run_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> TraceProjectionSnapshot | JSONResponse:
    """Read the projection snapshot for a task run's claimed Trace.

    The path ``task_run_id`` must match the service-token subject. The Trace
    is resolved through ``AgentTaskRunDB.trace_run_id`` — never a caller-
    supplied Trace ID.
    """
    project, token_task_run_id = _require_service_token(request)

    # The token subject must equal the path's task_run_id. A mismatch is a
    # cross-run read attempt -> 403, and we must not leak the other run's
    # trace ID in the response.
    if token_task_run_id != task_run_id:
        raise HTTPException(status_code=403, detail="Not authorized for this task run")

    task_run = _load_task_run(session, project=project, task_run_id=task_run_id)

    if task_run.trace_run_id is None:
        # Completed (or otherwise) without a Trace claim.
        raise HTTPException(status_code=409, detail="Task run has no trace")

    repo = get_trace_repository(project)
    snapshot = repo.get_projection_snapshot(
        session,
        project_id=project,
        trace_id=task_run.trace_run_id,
    )
    # Not-ready responses use the spec's {"status":"pending"} body (not the
    # HTTPException {"detail":...} shape) plus a Retry-After header.
    if snapshot is None or not snapshot.trace.complete:
        return JSONResponse(
            status_code=202,
            content={"status": "pending"},
            headers={"Retry-After": _RETRY_AFTER_SECONDS},
        )
    return snapshot
