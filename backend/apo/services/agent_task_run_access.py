"""Reusable Task Run access authorization.

One helper owns the Project-derivation + own-service-token rule so every
Deliverable upload, download, lookup, and the touched Task Run detail/result
routes apply identical scoping. A content feature must not preserve
cross-Project lookup by globally opaque ID as an implicit authorization
strategy.

The Project is ALWAYS derived through ``AgentTaskBatchRunDB`` — never from
request JSON or query parameters.

- service or Attempt token: ``request.state.project`` must equal the batch
  Project and ``service_task_run_id`` must equal the Task Run ID;
- API key / dashboard cookie / open-dev: the canonical Project policy
  authorizes the caller against the batch Project. Non-member
  access is opaque (404) so an opaque ID does not reveal existence.
"""

# pyright: reportUnusedCallResult=false

from __future__ import annotations

from fastapi import HTTPException, Request
from sqlmodel import Session

from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB
from apo.services.demo_workspace import require_project_not_demo
from apo.services.project_memberships import authorize_project_request


def require_task_run_access(
    request: Request,
    session: Session,
    task_run: AgentTaskRunDB,
    *,
    write: bool,
) -> str:
    """Authorize and return the Task Run's Project.

    Capability tokens (service / Attempt) are exact-run-scoped: a mismatch
    raises 404 so a cross-run guess cannot infer the existence of another run.
    Session / API-key / open-dev callers go through the canonical Project
    policy; non-member access is also 404 (opaque denial).
    Writes against the demo Project are rejected with 403.
    """
    batch = session.get(AgentTaskBatchRunDB, task_run.batch_run_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Task run not found")
    project = batch.project

    auth_method = getattr(request.state, "auth_method", None)
    if auth_method in ("service_token", "attempt_token"):
        token_project = getattr(request.state, "project", None)
        token_run_id = getattr(request.state, "service_task_run_id", None)
        if token_run_id != task_run.id or token_project != project:
            raise HTTPException(status_code=404, detail="Task run not found")
    else:
        # Session / API key / open-dev callers must be authorized
        # against the derived Project. Non-member → 404 (opaque), not 403,
        # so an opaque run ID cannot reveal the run's existence.
        try:
            authorize_project_request(request, session, project, minimum_role="member" if write else "viewer")
        except HTTPException as exc:
            if exc.status_code == 403:
                raise HTTPException(status_code=404, detail="Task run not found") from exc
            raise

    if write:
        require_project_not_demo(project)

    return project
