# pyright: reportCallInDefaultInitializer=false, reportUnusedImport=false

"""Executor Control Plane HTTP protocol.

All endpoints under ``/v1/executor-protocol/v1``. The protocol authenticates
itself (one-time enrollment token, long-lived ``apo_ex_`` credential, or a
``task_execution_attempt`` JWT) inside each handler via Depends — the path is
public to the user/api-key auth middleware so the two credential models stay
isolated. Every response carries ``X-Apo-Executor-Protocol: 1``.

This is a foundation spec: the routes are registered and Project scoped, but no
production run entry point queues through them until the bundled executor ships a proven
Executor.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import StreamingResponse
from jose import JWTError
from pydantic import BaseModel, Field
from sqlmodel import Session

from apo.auth.rate_limit import LoginRateLimiter
from apo.db import get_session
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ExecutorDB,
    TaskExecutionAttemptDB,
    TaskRevisionDB,
)
from apo.models.schemas import AgentTaskRunConfiguration
from apo.models.execution import EXECUTOR_PROTOCOL_VERSION, ExecutorCapabilities
from apo.services.execution_finalization import (
    AttemptFailureBody,
    AttemptResultBody,
    CompletionConflict,
    FinalizationError,
    finalize_attempt_failure,
    finalize_attempt_result,
)
from apo.services.execution_leases import (
    CurrentAttemptLease,
    LeaseError,
    claim_next_attempt,
    heartbeat_attempt,
    lease_error_to_http,
    start_attempt,
)
from apo.services.executor_auth import (
    EnrollmentError,
    create_attempt_jwt,
    decode_attempt_jwt,
    exchange_enrollment_token,
    resolve_executor_by_credential,
)
from apo.services.artifact_stores.registry import get_store

router = APIRouter(prefix="/v1/executor-protocol/v1", tags=["executor-protocol"])
PROTOCOL_VERSION = EXECUTOR_PROTOCOL_VERSION
_LEASE_JWT_TTL_SECONDS = 2 * 60 * 60  # covers max task timeout + finalization grace
_enrollment_rate_limiter = LoginRateLimiter(max_attempts=20, window_seconds=60)


class StartRequest(BaseModel):
    driver_kind: str
    runtime: dict[str, str] = Field(default_factory=dict)


class AttemptHeartbeatRequest(BaseModel):
    phase: str


class ResultRequest(BaseModel):
    completion_id: str
    pass_result: bool
    adapter_name: str | None = None
    trace_run_id: str | None = None
    checks: list[dict[str, object]] | None = None
    transcript: dict[str, object] | None = None
    deliverables: dict[str, object] | None = None
    exit_code: int | None = None
    stdout_tail: str | None = None
    stderr_tail: str | None = None
    error_message: str | None = None
    # the adapter's resolved model/effort for this attempt.
    run_configuration: AgentTaskRunConfiguration | None = None


class FailureRequest(BaseModel):
    completion_id: str
    failure_kind: str
    error_message: str | None = None
    exit_code: int | None = None
    stdout_tail: str | None = None
    stderr_tail: str | None = None


# ── auth dependencies ─────────────────────────────────────────────────────


def _bearer_token(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer credential")
    return auth.split(" ", 1)[1].strip()


def require_executor(request: Request, session: Session = Depends(get_session)) -> ExecutorDB:
    """Resolve an enabled, non-revoked Executor from its apo_ex_ credential."""
    token = _bearer_token(request)
    executor = resolve_executor_by_credential(session, token)
    if executor is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid executor credential")
    return executor


def require_attempt_lease(
    request: Request, session: Session = Depends(get_session)
) -> CurrentAttemptLease:
    """Decode the task_execution_attempt JWT and verify it against live DB state."""
    token = _bearer_token(request)
    try:
        claims = decode_attempt_jwt(token)
    except JWTError as exc:  # pragma: no cover - decode_attempt_jwt already guards
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid attempt token") from exc
    if claims is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid attempt token")
    attempt_id = str(claims.get("attempt_id"))
    raw_gen = claims.get("lease_generation")
    if not isinstance(raw_gen, int):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid attempt token")
    raw_executor = claims.get("executor_id")
    # Caller Attempts have no persistent Executor (executor_id is None); preserve
    # None rather than stringifying it so the own-only check matches the row.
    lease = CurrentAttemptLease(
        attempt_id=attempt_id,
        lease_generation=raw_gen,
        executor_id=str(raw_executor) if raw_executor is not None else "",
    )
    attempt = session.get(TaskExecutionAttemptDB, attempt_id)
    if attempt is None or attempt.lease_generation != lease.lease_generation:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"kind": "lease_stale"})
    return lease


# ── endpoints ─────────────────────────────────────────────────────────────


@router.post("/attempts/{attempt_id}/start")
async def attempt_start(
    attempt_id: str,
    body: StartRequest,
    response: Response,
    lease: CurrentAttemptLease = Depends(require_attempt_lease),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Mark an attempt started; records driver kind and runtime.

    Executor-lease authenticated; stale leases get 409."""
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    if lease.attempt_id != attempt_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "attempt token not valid for this attempt")
    try:
        started = start_attempt(session, lease=lease, driver_kind=body.driver_kind, runtime=body.runtime)
    except LeaseError as exc:
        raise lease_error_to_http(exc)
    return {"attempt_id": started.id, "status": started.status, "phase": started.phase}


@router.post("/attempts/{attempt_id}/heartbeat")
async def attempt_heartbeat(
    attempt_id: str,
    body: AttemptHeartbeatRequest,
    response: Response,
    lease: CurrentAttemptLease = Depends(require_attempt_lease),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Renew an attempt's execution lease and report progress.

    Returns whether a cancel has been requested; stale leases get 409."""
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    if lease.attempt_id != attempt_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "attempt token not valid for this attempt")
    try:
        resp = heartbeat_attempt(session, lease=lease, phase=body.phase)
    except LeaseError as exc:
        raise lease_error_to_http(exc)
    return {"cancel_requested": resp.cancel_requested}


@router.post("/attempts/{attempt_id}/result")
async def attempt_result(
    attempt_id: str,
    body: ResultRequest,
    response: Response,
    lease: CurrentAttemptLease = Depends(require_attempt_lease),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Finalize an attempt with its result, checks, transcript, and deliverables.

    Idempotent replays of an already-finalized completion return
    ``status: "replayed"``; completion conflicts get 409, deliverable
    validation errors 400/409."""
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    if lease.attempt_id != attempt_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "attempt token not valid for this attempt")
    try:
        from apo.services.execution_finalization import (
            AttemptResultBody,
            finalize_attempt_with_deliverables,
        )

        body_obj = AttemptResultBody(
            completion_id=body.completion_id, pass_result=body.pass_result,
            adapter_name=body.adapter_name, trace_run_id=body.trace_run_id,
            checks=body.checks, transcript=body.transcript,
            deliverables=None, exit_code=body.exit_code,
            stdout_tail=body.stdout_tail, stderr_tail=body.stderr_tail,
            error_message=body.error_message,
            run_configuration=body.run_configuration,
        )
        attempt = await finalize_attempt_with_deliverables(
            session, lease=lease, body=body_obj,
            deliverables=body.deliverables,
        )
        if attempt is None:
            return {"attempt_id": attempt_id, "status": "replayed"}
    except CompletionConflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"kind": "completion_conflict", "msg": str(exc)})
    except ValueError as exc:
        msg = str(exc)
        code = status.HTTP_409_CONFLICT if "non-ready" in msg or "already exists" in msg else status.HTTP_400_BAD_REQUEST
        raise HTTPException(code, detail={"kind": "deliverable_error", "msg": msg})
    except LeaseError as exc:
        raise lease_error_to_http(exc)
    except Exception as exc:
        import logging
        logging.getLogger("apo.routes.executor_protocol").exception(
            "Unexpected error finalizing attempt %s: %s", attempt_id, type(exc).__name__
        )
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"kind": "internal_error", "error": type(exc).__name__, "msg": str(exc)[:500]},
        )
    return {"attempt_id": attempt.id, "status": attempt.status}


@router.post("/attempts/{attempt_id}/failure")
async def attempt_failure(
    attempt_id: str,
    body: FailureRequest,
    response: Response,
    lease: CurrentAttemptLease = Depends(require_attempt_lease),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Finalize an attempt as failed with a typed failure kind and output tails.

    Completion conflicts get 409, finalization errors 400."""
    response.headers["X-Apo-Executor-Protocol"] = str(PROTOCOL_VERSION)
    if lease.attempt_id != attempt_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "attempt token not valid for this attempt")
    try:
        attempt = finalize_attempt_failure(
            session, lease=lease,
            body=AttemptFailureBody(
                completion_id=body.completion_id, failure_kind=body.failure_kind,
                error_message=body.error_message, exit_code=body.exit_code,
                stdout_tail=body.stdout_tail, stderr_tail=body.stderr_tail,
            ),
        )
    except CompletionConflict as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"kind": "completion_conflict", "msg": str(exc)},
        )
    except FinalizationError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    except LeaseError as exc:
        raise lease_error_to_http(exc)
    return {"attempt_id": attempt.id, "status": attempt.status}


__all__ = ["PROTOCOL_VERSION", "router"]
