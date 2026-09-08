"""Executor-protocol result-evidence routes (issue #251).

Attempt-scoped staging uploads for result fields too large for the result
envelope. Two endpoints, both authenticated by the Attempt JWT:

- ``POST /executor-protocol/{v1,v2}/attempts/{attempt_id}/result-evidence``
  — open an upload intent (idempotent on matching metadata);
- ``PUT /executor-protocol/result-evidence/{evidence_id}`` — stream the
  part bytes; the store verifies size and digest before the row is ready.

The PUT is version-neutral: the staging object is addressed by its opaque
id, not by protocol version. The terminal ``/result`` body references the
prepared parts by id (see ``execution_finalization``).
"""

# pyright: reportAny=false, reportCallInDefaultInitializer=false, reportPrivateLocalImportUsage=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnusedCallResult=false, reportUnusedImport=false, reportUnusedVariable=false

from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlmodel import Session

from ..db import get_session
from ..models.db import AgentTaskResultEvidenceDB, TaskExecutionAttemptDB
from ..services.execution_leases import CurrentAttemptLease
from ..services.request_body_limits import load_request_body_limits
from ..services.result_evidence import (
    ResultEvidenceError,
    complete_result_evidence_upload,
    create_result_evidence_intent,
)
from .executor_protocol import require_attempt_lease

router = APIRouter(prefix="/v1/executor-protocol", tags=["executor-protocol"])


class EvidenceIntentRequest(BaseModel):
    slot: str
    deliverable_name: str | None = None
    size_bytes: int
    sha256: str


class EvidenceIntentResponse(BaseModel):
    id: str
    slot: str
    deliverable_name: str | None
    status: str
    upload_url: str
    # The byte cap the request-size middleware enforces on the PUT.
    upload_max_bytes: int


def _error_status(kind: str) -> int:
    """Map a ResultEvidenceError kind to its HTTP status.

    Definite rejections of declared metadata (413/422) stay separable from
    state conflicts (409) and opaque misses (404) so the CLI can tell a
    protocol violation from a lost race.
    """
    if kind == "not_found":
        return status.HTTP_404_NOT_FOUND
    if kind == "item_too_large":
        return status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
    if kind in ("size_mismatch", "digest_mismatch"):
        return status.HTTP_422_UNPROCESSABLE_CONTENT
    if kind in ("attempt_not_running", "slot_conflict", "total_too_large", "not_ready"):
        return status.HTTP_409_CONFLICT
    return status.HTTP_422_UNPROCESSABLE_CONTENT


async def _create_intent(
    attempt_id: str,
    body: EvidenceIntentRequest,
    lease: CurrentAttemptLease,
    session: Session,
) -> EvidenceIntentResponse:
    if lease.attempt_id != attempt_id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "attempt token not valid for this attempt"
        )
    attempt = session.get(TaskExecutionAttemptDB, attempt_id)
    if attempt is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "attempt not found")

    from ..services.artifact_stores.registry import get_store

    try:
        row = await create_result_evidence_intent(
            session,
            get_store(None),
            attempt=attempt,
            slot=body.slot,
            deliverable_name=body.deliverable_name,
            size_bytes=body.size_bytes,
            sha256=body.sha256,
        )
        session.commit()
    except ResultEvidenceError as exc:
        session.rollback()
        raise HTTPException(
            _error_status(exc.kind), detail={"kind": exc.kind, "msg": exc.message}
        ) from exc
    except ValueError as exc:
        session.rollback()
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc
    return _intent_response(row)


def _intent_response(row: AgentTaskResultEvidenceDB) -> EvidenceIntentResponse:
    return EvidenceIntentResponse(
        id=row.id,
        slot=row.slot,
        deliverable_name=row.deliverable_name,
        status=row.status,
        upload_url=f"/v1/executor-protocol/result-evidence/{row.id}",
        upload_max_bytes=load_request_body_limits().result_evidence_max_bytes,
    )


@router.post(
    "/v1/attempts/{attempt_id}/result-evidence",
    response_model=EvidenceIntentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_intent_v1(
    attempt_id: str,
    body: EvidenceIntentRequest,
    lease: CurrentAttemptLease = Depends(require_attempt_lease),
    session: Session = Depends(get_session),
) -> EvidenceIntentResponse:
    """Open a result-evidence upload intent (protocol v1 path)."""
    return await _create_intent(attempt_id, body, lease, session)


@router.post(
    "/v2/attempts/{attempt_id}/result-evidence",
    response_model=EvidenceIntentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_intent_v2(
    attempt_id: str,
    body: EvidenceIntentRequest,
    lease: CurrentAttemptLease = Depends(require_attempt_lease),
    session: Session = Depends(get_session),
) -> EvidenceIntentResponse:
    """Open a result-evidence upload intent (protocol v2 path)."""
    return await _create_intent(attempt_id, body, lease, session)


@router.put("/result-evidence/{evidence_id}")
async def upload_result_evidence(
    evidence_id: str,
    request: Request,
    lease: CurrentAttemptLease = Depends(require_attempt_lease),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Stream evidence-part bytes; the store verifies size+digest."""
    attempt = session.get(TaskExecutionAttemptDB, lease.attempt_id)
    if attempt is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "attempt not found")

    from ..services.artifact_stores.registry import get_store

    declared = request.headers.get("content-length")
    declared_size = int(declared) if declared and declared.isdigit() else None

    async def body_stream() -> AsyncIterator[bytes]:
        async for chunk in request.stream():
            yield chunk

    try:
        row = await complete_result_evidence_upload(
            session,
            get_store(None),
            attempt=attempt,
            evidence_id=evidence_id,
            body_stream=body_stream(),
            declared_size=declared_size,
        )
        session.commit()
    except ResultEvidenceError as exc:
        session.rollback()
        raise HTTPException(
            _error_status(exc.kind), detail={"kind": exc.kind, "msg": exc.message}
        ) from exc
    return {"id": row.id, "status": row.status, "slot": row.slot}
