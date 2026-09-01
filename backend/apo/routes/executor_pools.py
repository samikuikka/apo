"""Executor Pool management APIs.

Added read/default. Later work adds the full Connected-Executor product
surface: create/archive Pool, enrollment tokens, executor list/revoke/rename —
all Project-scoped with role enforcement. User APIs can only create ``connected``
Pools; ``bundled``/``managed`` are provider-only.
"""

# pyright: reportAny=false, reportCallInDefaultInitializer=false, reportUnusedCallResult=false

from __future__ import annotations

import os
import re
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from importlib.metadata import PackageNotFoundError, version

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import or_
from sqlmodel import Session, select

from apo.auth.rate_limit import LoginRateLimiter
from apo.db import get_session
from apo.db_helpers import as_column
from apo.models.db import (
    AgentTaskScheduleDB,
    ExecutorDB,
    ExecutorEnrollmentTokenDB,
    ExecutorPoolDB,
    ProjectDB,
    TaskExecutionAttemptDB,
    UserDB,
)
from apo.models.execution import SUPPORTED_EXECUTOR_PROTOCOL_VERSIONS
from apo.services.execution_pools import PoolError, set_default_pool
from apo.services.executor_auth import generate_enrollment_token
from apo.services.project_memberships import enforce_project_role_from_request
from apo.services.runtime_config import get_runtime_config

router = APIRouter(prefix="/v1", tags=["executor-pools"])

_EXECUTOR_OFFLINE_THRESHOLD_SECONDS = 60
_MAX_LIVE_ENROLLMENT_TOKENS = 5
_MIN_QUEUE_TTL_SECONDS = 60
_MAX_QUEUE_TTL_SECONDS = 30 * 24 * 60 * 60
_SUPPORTED_DRIVER_KINDS = frozenset({"subprocess"})
_SLUG_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
_token_creation_rate_limiter = LoginRateLimiter(max_attempts=20, window_seconds=60)


class PoolSummary(BaseModel):
    id: str
    name: str
    slug: str
    kind: str
    enabled: bool
    archived: bool
    is_default: bool
    health: str  # online | busy | offline | disabled | incompatible
    online_executor_count: int
    available_capacity: int
    queue_ttl_seconds: int
    required_driver_kind: str


class PoolListResponse(BaseModel):
    pools: list[PoolSummary]


class SetDefaultPoolRequest(BaseModel):
    pool_id: str


@router.get("/projects/{project_id}/executor-pools", response_model=PoolListResponse)
async def list_executor_pools(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> PoolListResponse:
    """List a Project's Executor Pools with derived health + capacity."""
    _ = enforce_project_role_from_request(request, session, project_id, minimum_role="member")
    pools = session.exec(
        select(ExecutorPoolDB).where(ExecutorPoolDB.project == project_id)
    ).all()
    summaries: list[PoolSummary] = []
    for pool in pools:
        executor_scope = (
            or_(
                as_column(ExecutorDB.executor_pool_id) == pool.id,
                as_column(ExecutorDB.scope_kind) == "installation",
            )
            if pool.kind == "bundled"
            else as_column(ExecutorDB.executor_pool_id) == pool.id
        )
        executors = session.exec(
            select(ExecutorDB).where(
                executor_scope,
                as_column(ExecutorDB.enabled).is_(True),
                as_column(ExecutorDB.revoked_at).is_(None),
            )
        ).all()
        now = datetime.now(timezone.utc)
        online = [
            e for e in executors
            if e.last_seen_at is not None and (now - e.last_seen_at) <= timedelta(seconds=_EXECUTOR_OFFLINE_THRESHOLD_SECONDS)
        ]
        compatible = [
            executor
            for executor in online
            if executor.protocol_version in SUPPORTED_EXECUTOR_PROTOCOL_VERSIONS
            and pool.required_driver_kind in (executor.driver_kinds_json or [])
        ]
        available_capacity = sum(
            max(executor.max_concurrency - _active_attempt_count(session, executor.id), 0)
            for executor in compatible
        )
        summaries.append(PoolSummary(
            id=pool.id,
            name=pool.name,
            slug=pool.slug,
            kind=pool.kind,
            enabled=pool.enabled,
            archived=pool.archived_at is not None,
            is_default=_project_default_id(session, project_id) == pool.id,
            health=_derive_health(
                pool,
                online=online,
                compatible=compatible,
                available_capacity=available_capacity,
            ),
            online_executor_count=len(online),
            available_capacity=available_capacity,
            queue_ttl_seconds=pool.queue_ttl_seconds,
            required_driver_kind=pool.required_driver_kind,
        ))
    return PoolListResponse(pools=summaries)


@router.put("/projects/{project_id}/default-executor-pool")
async def set_default_executor_pool(
    project_id: str,
    body: SetDefaultPoolRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Designate an existing Pool as the Project default (admin/owner)."""
    _ = enforce_project_role_from_request(request, session, project_id, minimum_role="admin")
    try:
        project = set_default_pool(session, project_id=project_id, pool_id=body.pool_id)
    except PoolError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    return {"ok": True, "default_executor_pool_id": project.default_executor_pool_id}


def _project_default_id(session: Session, project_id: str) -> str | None:
    from apo.models.db import ProjectDB

    project = session.get(ProjectDB, project_id)
    return project.default_executor_pool_id if project is not None else None


def _derive_health(
    pool: ExecutorPoolDB,
    *,
    online: Sequence[ExecutorDB],
    compatible: Sequence[ExecutorDB],
    available_capacity: int,
) -> str:
    if pool.archived_at is not None:
        return "disabled"
    if not pool.enabled:
        return "disabled"
    if not online:
        return "offline"
    if not compatible:
        return "incompatible"
    if available_capacity <= 0:
        return "busy"
    return "online"


def _executor_status(
    ex: ExecutorDB,
    *,
    pool: ExecutorPoolDB | None,
    active_count: int,
) -> str:
    if ex.revoked_at is not None or not ex.enabled:
        return "disabled"
    if ex.last_seen_at is None or (datetime.now(timezone.utc) - ex.last_seen_at) > timedelta(seconds=_EXECUTOR_OFFLINE_THRESHOLD_SECONDS):
        return "offline"
    if (
        ex.protocol_version not in SUPPORTED_EXECUTOR_PROTOCOL_VERSIONS
        or pool is None
        or pool.required_driver_kind not in (ex.driver_kinds_json or [])
    ):
        return "incompatible"
    if active_count >= ex.max_concurrency:
        return "busy"
    return "online"


def _active_attempt_count(session: Session, executor_id: str) -> int:
    return len(session.exec(
        select(TaskExecutionAttemptDB).where(
            TaskExecutionAttemptDB.executor_id == executor_id,
            as_column(TaskExecutionAttemptDB.status).in_(["leased", "running"]),
        )
    ).all())


# ============================================================================
# Connected Pool CRUD
# ============================================================================


class CreatePoolRequest(BaseModel):
    name: str
    slug: str
    kind: str = "connected"
    queue_ttl_seconds: int = 86_400
    required_driver_kind: str = "subprocess"


class PatchPoolRequest(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    queue_ttl_seconds: int | None = None
    required_driver_kind: str | None = None


@router.post("/projects/{project_id}/executor-pools", status_code=201)
async def create_executor_pool_route(
    project_id: str,
    body: CreatePoolRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Create a Connected Pool. Users cannot create bundled/managed kinds."""
    _ = enforce_project_role_from_request(request, session, project_id, minimum_role="admin")
    if body.kind != "connected":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "user APIs can only create 'connected' pools")
    if not body.name.strip():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "name is required")
    _validate_queue_ttl(body.queue_ttl_seconds)
    _validate_driver_kind(body.required_driver_kind)
    if not _SLUG_RE.match(body.slug) or not (1 <= len(body.slug) <= 63):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "slug must be 1-63 lowercase ASCII letters/numbers/hyphens")
    existing = session.exec(
        select(ExecutorPoolDB).where(ExecutorPoolDB.project == project_id, ExecutorPoolDB.slug == body.slug)
    ).first()
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "a pool with this slug already exists")
    now = datetime.now(timezone.utc)
    pool = ExecutorPoolDB(
        project=project_id, name=body.name.strip(), slug=body.slug, kind="connected",
        enabled=True, queue_ttl_seconds=body.queue_ttl_seconds,
        required_driver_kind=body.required_driver_kind, created_at=now, updated_at=now,
    )
    session.add(pool)
    session.commit()
    session.refresh(pool)
    return _pool_detail(session, project_id, pool)


@router.patch("/projects/{project_id}/executor-pools/{pool_id}")
async def patch_executor_pool(
    project_id: str,
    pool_id: str,
    body: PatchPoolRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Patch Pool name/enabled/queue TTL/driver kind. Project admin only.

    Archived pools are immutable (409); the driver kind cannot change while
    nonterminal attempts exist (409).
    """
    _ = enforce_project_role_from_request(request, session, project_id, minimum_role="admin")
    pool = _require_project_pool(session, project_id, pool_id)
    if pool.archived_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "archived pools cannot be modified")
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "name is required")
        pool.name = body.name.strip()
    if body.enabled is not None:
        pool.enabled = body.enabled
    if body.queue_ttl_seconds is not None:
        _validate_queue_ttl(body.queue_ttl_seconds)
        pool.queue_ttl_seconds = body.queue_ttl_seconds
    if body.required_driver_kind is not None:
        _validate_driver_kind(body.required_driver_kind)
        # Only when no nonterminal attempt exists.
        active = session.exec(
            select(TaskExecutionAttemptDB).where(
                TaskExecutionAttemptDB.executor_pool_id == pool_id,
                as_column(TaskExecutionAttemptDB.status).in_(["queued", "leased", "running"]),
            )
        ).first()
        if active is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "cannot change driver kind with nonterminal attempts")
        pool.required_driver_kind = body.required_driver_kind
    pool.updated_at = datetime.now(timezone.utc)
    session.add(pool)
    session.commit()
    session.refresh(pool)
    return _pool_detail(session, project_id, pool)


@router.delete("/projects/{project_id}/executor-pools/{pool_id}")
async def archive_executor_pool(
    project_id: str,
    pool_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Soft-archive a Pool: require no active Attempt, clear default, disable schedules."""
    _ = enforce_project_role_from_request(request, session, project_id, minimum_role="owner")
    pool = _require_project_pool(session, project_id, pool_id)
    if pool.archived_at is not None:
        return {"ok": True, "archived": pool_id}
    active = session.exec(
        select(TaskExecutionAttemptDB).where(
            TaskExecutionAttemptDB.executor_pool_id == pool_id,
            as_column(TaskExecutionAttemptDB.status).in_(["leased", "running"]),
        )
    ).first()
    if active is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"kind": "pool_in_use"})
    pool.enabled = False
    pool.archived_at = datetime.now(timezone.utc)
    session.add(pool)
    # Clear Project default if it references this Pool.
    project = session.get(ProjectDB, project_id)
    if project is not None and project.default_executor_pool_id == pool_id:
        project.default_executor_pool_id = None
        session.add(project)
    # Disable referencing schedules.
    schedules = session.exec(
        select(AgentTaskScheduleDB).where(AgentTaskScheduleDB.executor_pool_id == pool_id)
    ).all()
    for s in schedules:
        s.enabled = False
        s.disabled_reason = "executor_pool_archived"
        session.add(s)
    session.commit()
    session.refresh(pool)
    return {"ok": True, "archived": pool_id}


# ============================================================================
# Enrollment tokens
# ============================================================================


class EnrollmentTokenResponse(BaseModel):
    id: str
    pool_id: str
    token: str
    expires_at: datetime
    container: dict[str, object]


@router.post(
    "/projects/{project_id}/executor-pools/{pool_id}/enrollment-tokens",
    response_model=EnrollmentTokenResponse,
    status_code=201,
)
async def create_enrollment_token_route(
    project_id: str,
    pool_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> EnrollmentTokenResponse:
    """Mint a single-use Executor enrollment token with container config.

    Project admin only; rate-limited per admin. Refuses archived/disabled
    pools (409) and more than the per-pool live-token cap. Returns 201 —
    the raw token is only shown once.
    """
    actor = enforce_project_role_from_request(
        request,
        session,
        project_id,
        minimum_role="admin",
    )
    rate_limit_key = f"{project_id}:{actor.user_id}"
    _enforce_rate_limit(_token_creation_rate_limiter, rate_limit_key)
    pool = _require_project_pool(session, project_id, pool_id)
    if pool.archived_at is not None or not pool.enabled:
        raise HTTPException(status.HTTP_409_CONFLICT, "cannot enroll into an archived/disabled pool")
    live = session.exec(
        select(ExecutorEnrollmentTokenDB).where(
            ExecutorEnrollmentTokenDB.executor_pool_id == pool_id,
            as_column(ExecutorEnrollmentTokenDB.used_at).is_(None),
            as_column(ExecutorEnrollmentTokenDB.revoked_at).is_(None),
            ExecutorEnrollmentTokenDB.expires_at > datetime.now(timezone.utc),
        )
    ).all()
    if len(live) >= _MAX_LIVE_ENROLLMENT_TOKENS:
        raise HTTPException(status.HTTP_409_CONFLICT, f"at most {_MAX_LIVE_ENROLLMENT_TOKENS} live enrollment tokens per pool")
    raw_token, row = generate_enrollment_token(
        session,
        scope_kind="pool",
        project_id=project_id,
        pool_id=pool_id,
        created_by_user_id=(
            actor.user_id
            if session.get(UserDB, actor.user_id) is not None
            else None
        ),
    )
    return EnrollmentTokenResponse(
        id=row.id,
        pool_id=pool.id,
        token=raw_token,
        expires_at=row.expires_at,
        container=_container_config(raw_token, pool),
    )


@router.delete(
    (
        "/projects/{project_id}/executor-pools/{pool_id}"
        "/enrollment-tokens/{token_id}"
    )
)
async def revoke_enrollment_token_route(
    project_id: str,
    pool_id: str,
    token_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Revoke one unused enrollment token without exposing its secret."""
    _ = enforce_project_role_from_request(
        request,
        session,
        project_id,
        minimum_role="admin",
    )
    pool = _require_project_pool(session, project_id, pool_id)
    token = session.get(ExecutorEnrollmentTokenDB, token_id)
    if (
        token is None
        or token.project != project_id
        or token.executor_pool_id != pool.id
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "enrollment token not found")
    if token.used_at is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"kind": "token_used"},
        )
    if token.revoked_at is None:
        token.revoked_at = datetime.now(timezone.utc)
        session.add(token)
        session.commit()
    return {"ok": True, "revoked": token.id}


def _container_config(token: str, pool: ExecutorPoolDB) -> dict[str, object]:
    try:
        package_version = version("apo-backend")
    except PackageNotFoundError:
        package_version = "0.2.0"
    image = os.environ.get(
        "APO_EXECUTOR_IMAGE",
        f"ghcr.io/samikuikka/apo-backend:{package_version}",
    )
    control_url = os.environ.get("APO_EXECUTOR_CONTROL_PLANE_URL", "").strip()
    if not control_url:
        public_url = get_runtime_config().public_url.rstrip("/")
        control_url = f"{public_url}/backend-proxy"
    return {
        "image": image,
        "command": ["python", "-m", "apo.executor", "connect"],
        "environment": {
            "APO_CONTROL_PLANE_URL": control_url,
            "APO_EXECUTOR_ENROLLMENT_TOKEN": token,
            "APO_EXECUTOR_NAME": f"{pool.slug}-1",
        },
        "state_volume": "/var/lib/apo-executor",
    }


# ============================================================================
# Executor list / revoke / rename
# ============================================================================


class ExecutorSummaryResponse(BaseModel):
    id: str
    pool_id: str
    name: str
    status: str
    executor_version: str
    protocol_version: int
    driver_kinds: list[str]
    os: str
    architecture: str
    max_concurrency: int
    active_attempts: int
    last_seen_at: datetime | None
    enrolled_at: datetime


class ExecutorListResponse(BaseModel):
    executors: list[ExecutorSummaryResponse]


@router.get("/projects/{project_id}/executors", response_model=ExecutorListResponse)
async def list_executors(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> ExecutorListResponse:
    """List a Project's Executors with status, versions, capabilities,
    and active attempt counts. Project members and above."""
    _ = enforce_project_role_from_request(request, session, project_id, minimum_role="member")
    executors = session.exec(
        select(ExecutorDB).where(ExecutorDB.project == project_id)
    ).all()
    pools_by_id = {
        pool.id: pool
        for pool in session.exec(
            select(ExecutorPoolDB).where(ExecutorPoolDB.project == project_id)
        ).all()
    }
    summaries = [
        ExecutorSummaryResponse(
            id=ex.id, pool_id=ex.executor_pool_id or "", name=ex.name,
            status=_executor_status(
                ex,
                pool=pools_by_id.get(ex.executor_pool_id or ""),
                active_count=_active_attempt_count(session, ex.id),
            ),
            executor_version=ex.executor_version, protocol_version=ex.protocol_version,
            driver_kinds=ex.driver_kinds_json or [], os=str((ex.capabilities_json or {}).get("os", "")),
            architecture=str((ex.capabilities_json or {}).get("architecture", "")),
            max_concurrency=ex.max_concurrency,
            active_attempts=_active_attempt_count(session, ex.id),
            last_seen_at=ex.last_seen_at, enrolled_at=ex.enrolled_at,
        )
        for ex in executors
    ]
    return ExecutorListResponse(executors=summaries)


class RevokeExecutorRequest(BaseModel):
    pass


@router.post("/projects/{project_id}/executors/{executor_id}/revoke")
async def revoke_executor_route(
    project_id: str,
    executor_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Revoke an Executor: fence running (lost) + requeue pre-start."""
    _ = enforce_project_role_from_request(request, session, project_id, minimum_role="admin")
    ex = session.get(ExecutorDB, executor_id)
    if ex is None or ex.project != project_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "executor not found")
    ex.revoked_at = datetime.now(timezone.utc)
    ex.enabled = False
    session.add(ex)
    # Fence its attempts.
    attempts = session.exec(
        select(TaskExecutionAttemptDB).where(
            TaskExecutionAttemptDB.executor_id == executor_id,
            as_column(TaskExecutionAttemptDB.status).in_(["leased", "running"]),
        )
    ).all()
    now = datetime.now(timezone.utc)
    for att in attempts:
        if att.started_at is None:
            att.status = "queued"
            att.executor_id = None
            att.claimed_at = None
            att.lease_expires_at = None
        else:
            att.status = "lost"
            att.failure_kind = "executor_revoked"
            att.completed_at = now
        session.add(att)
    session.commit()
    return {"ok": True, "revoked": executor_id}


class RenameExecutorRequest(BaseModel):
    name: str


@router.post("/projects/{project_id}/executors/{executor_id}/rename")
async def rename_executor_route(
    project_id: str,
    executor_id: str,
    body: RenameExecutorRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Rename an Executor. Project admin only; blank names get 422."""
    _ = enforce_project_role_from_request(request, session, project_id, minimum_role="admin")
    ex = session.get(ExecutorDB, executor_id)
    if ex is None or ex.project != project_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "executor not found")
    name = body.name.strip()
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "name is required")
    ex.name = name
    ex.updated_at = datetime.now(timezone.utc)
    session.add(ex)
    session.commit()
    session.refresh(ex)
    return {"ok": True, "id": ex.id, "name": ex.name}


# ── helpers ───────────────────────────────────────────────────────────────


def _require_project_pool(session: Session, project_id: str, pool_id: str) -> ExecutorPoolDB:
    pool = session.get(ExecutorPoolDB, pool_id)
    if pool is None or pool.project != project_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "pool not found")
    return pool


def _validate_queue_ttl(queue_ttl_seconds: int) -> None:
    if not _MIN_QUEUE_TTL_SECONDS <= queue_ttl_seconds <= _MAX_QUEUE_TTL_SECONDS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            (
                "queue_ttl_seconds must be between "
                f"{_MIN_QUEUE_TTL_SECONDS} and {_MAX_QUEUE_TTL_SECONDS}"
            ),
        )


def _validate_driver_kind(driver_kind: str) -> None:
    if driver_kind not in _SUPPORTED_DRIVER_KINDS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "required_driver_kind must be 'subprocess'",
        )


def _enforce_rate_limit(limiter: LoginRateLimiter, key: str) -> None:
    if not limiter.is_allowed(key):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "too many enrollment token requests",
            headers={"Retry-After": str(limiter.get_retry_after(key))},
        )
    limiter.record_attempt(key)


def _pool_detail(session: Session, project_id: str, pool: ExecutorPoolDB) -> dict[str, object]:
    executor_scope = (
        or_(
            as_column(ExecutorDB.executor_pool_id) == pool.id,
            as_column(ExecutorDB.scope_kind) == "installation",
        )
        if pool.kind == "bundled"
        else as_column(ExecutorDB.executor_pool_id) == pool.id
    )
    executors = session.exec(
        select(ExecutorDB).where(
            executor_scope,
            as_column(ExecutorDB.enabled).is_(True),
            as_column(ExecutorDB.revoked_at).is_(None),
        )
    ).all()
    now = datetime.now(timezone.utc)
    online = [
        executor
        for executor in executors
        if executor.last_seen_at is not None
        and now - executor.last_seen_at <= timedelta(seconds=_EXECUTOR_OFFLINE_THRESHOLD_SECONDS)
    ]
    compatible = [
        executor
        for executor in online
        if executor.protocol_version in SUPPORTED_EXECUTOR_PROTOCOL_VERSIONS
        and pool.required_driver_kind in (executor.driver_kinds_json or [])
    ]
    available_capacity = sum(
        max(executor.max_concurrency - _active_attempt_count(session, executor.id), 0)
        for executor in compatible
    )
    return {
        "id": pool.id, "project": pool.project, "name": pool.name, "slug": pool.slug,
        "kind": pool.kind, "enabled": pool.enabled, "archived": pool.archived_at is not None,
        "is_default": _project_default_id(session, project_id) == pool.id,
        "health": _derive_health(
            pool,
            online=online,
            compatible=compatible,
            available_capacity=available_capacity,
        ),
        "online_executor_count": len(online),
        "available_capacity": available_capacity,
        "queue_ttl_seconds": pool.queue_ttl_seconds,
        "required_driver_kind": pool.required_driver_kind,
    }


# ---------------------------------------------------------------------------
# Member-authorized Connected Executor bootstrap
# ---------------------------------------------------------------------------


class ConnectedExecutorBootstrapRequest(BaseModel):
    name: str
    capabilities: dict[str, object]


@router.post("/projects/{project_id}/connected-executor-bootstrap", status_code=201)
async def connected_executor_bootstrap(
    project_id: str,
    body: ConnectedExecutorBootstrapRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Issue a one-time enrollment token for a source-owned Connected Executor.

    Any project member may bootstrap. Creates the canonical system-managed
    source-owned Pool if it does not exist.
    """
    # Require project membership before bootstrap.
    enforce_project_role_from_request(
        request, session, project_id, minimum_role="member"
    )

    from ..services.source_owned_executor import bootstrap_connected_executor

    user_id = request.state.user_id if hasattr(request.state, "user_id") else None
    if not user_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Authentication required")

    result = bootstrap_connected_executor(
        session,
        project_id=project_id,
        user_id=user_id,
        name=body.name,
    )

    return {
        "enrollment_token": result.enrollment_token,
        "expires_at": result.expires_at.isoformat(),
        "protocol_version": result.protocol_version,
    }


# ---------------------------------------------------------------------------
# aggregate Connected Executor status for the dashboard
# ---------------------------------------------------------------------------


@router.get("/projects/{project_id}/connected-executor-status")
async def connected_executor_status(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Return the acting User's aggregate Connected Environment state.

    Requires Project membership; derives the User exclusively from the
    authenticated request. Returns only ``{ "state": "..." }`` — never
    Executor IDs, names, hostnames, OSes, Pool IDs, credentials, or
    catalog digests. Returns ``200`` (including ``not_connected``).
    """
    membership = enforce_project_role_from_request(
        request, session, project_id, minimum_role="member"
    )
    from ..services.connected_executor_status import (
        compute_connected_environment_status,
    )

    status_view = compute_connected_environment_status(
        session, project_id=project_id, user_id=membership.user_id
    )
    return {"state": status_view.state}


__all__ = ["router"]
