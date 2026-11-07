"""Task Definition source reader route.

Reads the pinned canonical ``*.eval.ts`` source for a Run so the dashboard
can render CodeMirror with the historical definition that produced stored
Check evidence. Authorization is Project-bound through the Run's Batch.
"""

# pyright: reportCallInDefaultInitializer=false

from __future__ import annotations

from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlmodel import Session

from ..auth.deps import require_api_key_scope
from ..db import get_session
from ..models.db import AgentTaskBatchRunDB, AgentTaskRunDB
from ..services.project_memberships import enforce_project_role_from_request
from ..services.task_definition_revisions import (
    MAX_DEFINITION_BYTES,
    read_definition_source,
)

router = APIRouter(prefix="/v1", tags=["task-definitions"])


@router.get("/task-definition-source")
async def get_task_definition_source(
    request: Request,
    task_run_id: str = Query(...),
    file_path: str = Query(...),
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
) -> dict[str, object]:
    """Read one source file from a Run's pinned Task Definition Revision.

    Authorization resolves from ``task_run_id → batch.project``:
    Project members may read source for their Project; ingest-only and
    Executor credentials cannot (scope enforced here for API keys,
    path-restricted by the middleware for tokens). Unknown Run, missing
    Revision, or unknown file returns 404 without disclosing which is
    absent.
    """
    run = session.get(AgentTaskRunDB, task_run_id)
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"kind": "definition_source_not_found"})

    batch = session.get(AgentTaskBatchRunDB, run.batch_run_id)
    if batch is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"kind": "definition_source_not_found"})

    # Enforce Project membership through the Run's Batch.
    _ = enforce_project_role_from_request(
        request, session, batch.project, minimum_role="viewer"
    )

    result = read_definition_source(session, task_run_id=task_run_id, file_path=file_path)
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"kind": "definition_source_not_found"})

    if cast(int, result["size_bytes"]) > MAX_DEFINITION_BYTES:
        # Write-time validation caps revisions at the same bound, so this
        # only trips on legacy or unvalidated rows; serve a clean 413
        # instead of an unbounded file body.
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail=(
                f"Definition source file exceeds the {MAX_DEFINITION_BYTES} byte cap"
            ),
        )

    return result


__all__ = ["router"]
