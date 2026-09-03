"""Task Run Deliverable routes.

All paths live under the existing ``/v1`` router. The specific Deliverable
routes are declared before any future catch-all ``{name:path}`` route;
Deliverable IDs are opaque path segments, names never form route paths.

Endpoints:

- ``GET /agent-task-runs/{run_id}/deliverables`` — manifest (metadata only)
- ``GET /agent-task-runs/{run_id}/deliverables/{deliverable_id}`` — one body
- ``POST /agent-task-runs/{run_id}/artifact-uploads`` — open upload intent
- ``PUT /agent-task-artifact-uploads/{upload_id}`` — stream Artifact bytes

Authorization flows through ``require_task_run_access``: the Project is always
derived through the batch run, never from request JSON; service tokens are
confined to their own Task Run.
"""

# pyright: reportAny=false, reportCallInDefaultInitializer=false, reportExplicitAny=false, reportUnusedImport=false

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlmodel import Session

from ..db import get_session
from ..models.db import AgentTaskDeliverableDB, AgentTaskRunDB, TaskExecutionAttemptDB
from ..models.schemas import (
    AgentTaskDeliverableManifest,
    ArtifactUploadIntent,
    CreateArtifactUploadRequest,
)
from ..services.agent_task_deliverables import (
    build_deliverable_manifest,
    complete_artifact_upload,
    create_artifact_upload_intent,
    load_deliverable_for_download,
    read_json_deliverable_value,
)
from ..services.agent_task_run_access import require_task_run_access
from ..services.artifact_stores.registry import get_store

router = APIRouter(prefix="/v1", tags=["agent-tasks"])


def _get_store_for_row(row: AgentTaskDeliverableDB) -> Any:
    return get_store(row.storage_backend)


def _require_running_attempt(request: Request, session: Session) -> None:
    """Artifact uploads require a currently running Attempt.

    A leased (pre-start) attempt has not begun task code, so no artifact can
    exist yet. Service tokens bypass this check (backend-spawned runner).
    """
    if getattr(request.state, "auth_method", None) != "attempt_token":
        return
    attempt_id = getattr(request.state, "attempt_id", None)
    if not attempt_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Artifact upload requires a running Attempt",
        )
    attempt = session.get(TaskExecutionAttemptDB, attempt_id)
    if attempt is None or attempt.status != "running":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Artifact upload requires a running Attempt",
        )


def _load_task_run_or_404(session: Session, task_run_id: str) -> AgentTaskRunDB:
    task_run = session.get(AgentTaskRunDB, task_run_id)
    if task_run is None:
        raise HTTPException(status_code=404, detail="Task run not found")
    return task_run


@router.get(
    "/agent-task-runs/{task_run_id}/deliverables",
    response_model=AgentTaskDeliverableManifest,
)
async def get_deliverables_manifest(
    task_run_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> AgentTaskDeliverableManifest:
    """Return the Deliverable manifest for one Task Run — metadata only.

    Built from the canonical ``AgentTaskDeliverableDB`` rows; no body is
    loaded.
    """
    task_run = _load_task_run_or_404(session, task_run_id)
    project = require_task_run_access(request, session, task_run, write=False)
    _ = project

    items = build_deliverable_manifest(session, task_run_id)
    return AgentTaskDeliverableManifest(task_run_id=task_run_id, items=items)


@router.get("/agent-task-runs/{task_run_id}/deliverables/{deliverable_id}")
async def get_deliverable_body(
    task_run_id: str,
    deliverable_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> StreamingResponse:
    """Stream one Deliverable body. JSON returns the value; Artifacts stream bytes.

    Only this route opens a body. Download semantics:
    - JSON: ``Content-Type: application/json; charset=utf-8``, ``ETag: <sha256>``;
    - Artifact: stored media type, ``Content-Disposition: attachment``,
      ``X-Content-Type-Options: nosniff``, ``ETag: <sha256>``.
    """
    task_run = _load_task_run_or_404(session, task_run_id)
    project = require_task_run_access(request, session, task_run, write=False)

    try:
        row = load_deliverable_for_download(
            session, project=project, deliverable_id=deliverable_id
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="Deliverable not found")
    if row.task_run_id != task_run_id:
        raise HTTPException(status_code=404, detail="Deliverable not found")

    if row.kind == "json":
        value = await read_json_deliverable_value(
            session, deliverable_id, store=_get_store_for_row(row)
        )
        import json

        body = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        return _json_response(body, row.sha256)

    if row.storage_key is None or row.storage_backend is None:
        raise HTTPException(status_code=503, detail="Artifact object is unavailable")

    store = _get_store_for_row(row)
    return StreamingResponse(
        store.open(row.storage_key),
        media_type=row.media_type,
        headers={
            "ETag": f'"{row.sha256}"',
            "Content-Disposition": _attachment_disposition(row),
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post(
    "/agent-task-runs/{task_run_id}/artifact-uploads",
    response_model=ArtifactUploadIntent,
    status_code=status.HTTP_201_CREATED,
)
async def create_artifact_upload(
    task_run_id: str,
    payload: CreateArtifactUploadRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> ArtifactUploadIntent:
    """Open a two-phase Artifact upload intent for a Task Run."""
    task_run = _load_task_run_or_404(session, task_run_id)
    project = require_task_run_access(request, session, task_run, write=True)
    _require_running_attempt(request, session)
    store = get_store(None)  # default configured write backend
    try:
        intent = await create_artifact_upload_intent(
            session,
            store,
            project=project,
            task_run_id=task_run_id,
            name=payload.name,
            display_filename=payload.display_filename,
            media_type=payload.media_type,
            size_bytes=payload.size_bytes,
            sha256=payload.sha256,
        )
        session.commit()
    except ValueError as exc:
        msg = str(exc)
        status_code = (
            status.HTTP_409_CONFLICT
            if "conflicting" in msg or "terminal" in msg or "already exists" in msg or "closed" in msg
            else status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
            if "limit" in msg
            else status.HTTP_400_BAD_REQUEST
        )
        raise HTTPException(status_code=status_code, detail=msg) from exc
    return intent


@router.put("/agent-task-artifact-uploads/{upload_id}")
async def upload_artifact_bytes(
    upload_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Stream Artifact bytes, verify size+digest, mark the row ready."""
    row = session.get(AgentTaskDeliverableDB, upload_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Upload not found")
    task_run = _load_task_run_or_404(session, row.task_run_id)
    project = require_task_run_access(request, session, task_run, write=True)
    _require_running_attempt(request, session)

    declared = request.headers.get("content-length")
    declared_size = int(declared) if declared and declared.isdigit() else None
    store = get_store(row.storage_backend)

    async def body_stream() -> AsyncIterator[bytes]:
        async for chunk in request.stream():
            yield chunk

    try:
        summary = await complete_artifact_upload(
            session,
            store,
            project=project,
            deliverable_id=upload_id,
            body_stream=body_stream(),
            declared_size=declared_size,
        )
        session.commit()
    except KeyError:
        raise HTTPException(status_code=404, detail="Upload not found")
    except ValueError as exc:
        msg = str(exc)
        if "mismatch" in msg:
            raise HTTPException(status_code=422, detail=msg) from exc
        raise HTTPException(status_code=400, detail=msg) from exc
    return summary.model_dump()


def _json_response(body: bytes, sha256: str) -> StreamingResponse:
    async def _stream() -> AsyncIterator[bytes]:
        yield body

    return StreamingResponse(
        _stream(),
        media_type="application/json; charset=utf-8",
        headers={"ETag": f'"{sha256}"'},
    )


def _attachment_disposition(row: AgentTaskDeliverableDB) -> str:
    from urllib.parse import quote

    name = row.display_filename or "artifact"
    return f"attachment; filename*=UTF-8''{quote(name)}"
