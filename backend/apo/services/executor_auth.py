# pyright: reportPrivateUsage=false, reportUnusedImport=false

"""Executor authentication — enrollment, credentials, Attempt JWTs.

Three concerns, all mirroring existing patterns so there is one credential
model across the product:

- ``apo_enroll_`` one-time tokens: SHA-256+salt hash + prefix persisted, raw
  returned once, single-use atomic exchange, 15-minute TTL.
- ``apo_ex_`` long-lived Executor credentials: same hash/prefix scheme as API
  keys (``api_key_auth._hash_secret_key``); raw returned once at enrollment.
- ``task_execution_attempt`` JWTs: HS256 with the shared ``AUTH_SECRET``, same
  library as service tokens; carry Project/Task Run/Attempt/Executor/generation.

Raw credentials/tokens never appear in logs or persisted plaintext.
"""

from __future__ import annotations

import hashlib
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone

from jose import JWTError, jwt
from sqlmodel import Session, select

from apo.auth.api_key_auth import get_salt
from apo.db_helpers import as_column
from apo.models.db import (
    ExecutorDB,
    ExecutorEnrollmentTokenDB,
    ExecutorPoolDB,
    TaskExecutionAttemptDB,
)
from apo.models.execution import SUPPORTED_EXECUTOR_PROTOCOL_VERSIONS, ExecutorCapabilities

logger = logging.getLogger(__name__)

ALGORITHM = "HS256"
AUTH_SECRET = os.environ.get("AUTH_SECRET", "")
if not AUTH_SECRET:
    logger.warning("AUTH_SECRET not set. Executor Attempt JWTs will not be issued.")

ATTEMPT_JWT_TYPE = "task_execution_attempt"

_CREDENTIAL_PREFIX = "apo_ex_"
_ENROLLMENT_PREFIX = "apo_enroll_"
_ENROLLMENT_TTL_SECONDS = 15 * 60
_PREFIX_DISPLAY_LEN = 8


class CredentialHashError(ValueError):
    """Raised when a raw credential does not match the expected prefix/shape."""


class EnrollmentError(ValueError):
    """Raised when a token or enrollment request cannot be exchanged safely."""

    kind: str

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


def _hash_with_salt(raw: str) -> str:
    """SHA-256 of raw:salt — identical scheme to API keys."""
    return hashlib.sha256(f"{raw}:{get_salt()}".encode()).hexdigest()


def hash_credential(raw: str) -> str:
    """Hash an ``apo_ex_`` credential. Reject anything without the prefix."""
    if not raw.startswith(_CREDENTIAL_PREFIX):
        raise CredentialHashError("executor credential must start with apo_ex_")
    return _hash_with_salt(raw)


def generate_credential() -> tuple[str, str, str]:
    """Generate a raw ``apo_ex_`` credential. Returns (raw, prefix, hash)."""
    raw = f"{_CREDENTIAL_PREFIX}{secrets.token_hex(24)}"
    prefix = raw[: len(_CREDENTIAL_PREFIX) + _PREFIX_DISPLAY_LEN]
    return raw, prefix, _hash_with_salt(raw)


def generate_enrollment_token(
    session: Session,
    *,
    scope_kind: str,
    project_id: str | None,
    pool_id: str | None,
    created_by_user_id: str | None = None,
    ttl_seconds: int = _ENROLLMENT_TTL_SECONDS,
) -> tuple[str, ExecutorEnrollmentTokenDB]:
    """Mint a one-time enrollment token. Returns (raw_token, persisted_row)."""
    raw = f"{_ENROLLMENT_PREFIX}{secrets.token_hex(24)}"
    row = ExecutorEnrollmentTokenDB(
        scope_kind=scope_kind,
        project=project_id,
        executor_pool_id=pool_id,
        token_prefix=raw[: len(_ENROLLMENT_PREFIX) + _PREFIX_DISPLAY_LEN],
        token_hash=_hash_with_salt(raw),
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds),
        created_by_user_id=created_by_user_id,
        created_at=datetime.now(timezone.utc),
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return raw, row


def resolve_enrollment_token(
    session: Session,
    raw_token: str,
) -> ExecutorEnrollmentTokenDB | None:
    """Resolve an enrollment token without consuming it."""
    if not raw_token.startswith(_ENROLLMENT_PREFIX):
        return None
    token_hash = _hash_with_salt(raw_token)
    return session.exec(
        select(ExecutorEnrollmentTokenDB).where(
            ExecutorEnrollmentTokenDB.token_hash == token_hash
        )
    ).first()


def exchange_enrollment_token(
    session: Session,
    *,
    raw_token: str,
    name: str,
    capabilities: ExecutorCapabilities,
) -> tuple[ExecutorDB, str, int, int]:
    """Atomically exchange a one-time token for a persistent Executor credential.

    Returns (executor, raw_credential, heartbeat_interval_seconds, lease_ttl_seconds).
    Raises :class:`EnrollmentError` if the token is unknown, expired, revoked, or
    already used. Concurrent exchange permits exactly one success.
    """
    row = resolve_enrollment_token(session, raw_token)
    if row is None:
        raise EnrollmentError("token_invalid", "unknown enrollment token")
    now = datetime.now(timezone.utc)
    if row.used_at is not None:
        raise EnrollmentError("token_used", "enrollment token already redeemed")
    if row.revoked_at is not None:
        raise EnrollmentError("token_invalid", "enrollment token was revoked")
    if row.expires_at <= now:
        raise EnrollmentError("token_expired", "enrollment token expired")
    _validate_enrollment_request(session, row, name, capabilities)

    # Atomic single-use: conditional update only when still unused.
    from sqlalchemy import update

    result = session.exec(
        update(ExecutorEnrollmentTokenDB)
        .where(
            as_column(ExecutorEnrollmentTokenDB.id) == row.id,
            as_column(ExecutorEnrollmentTokenDB.used_at).is_(None),
            as_column(ExecutorEnrollmentTokenDB.revoked_at).is_(None),
            as_column(ExecutorEnrollmentTokenDB.expires_at) > now,
        )
        .values(used_at=now)
    )
    if result.rowcount == 0:
        raise EnrollmentError("token_used", "enrollment token already redeemed")

    raw_credential, prefix, cred_hash = generate_credential()
    executor = ExecutorDB(
        scope_kind=row.scope_kind,
        project=row.project,
        executor_pool_id=row.executor_pool_id,
        name=name.strip(),
        enabled=True,
        credential_prefix=prefix,
        credential_hash=cred_hash,
        protocol_version=capabilities.protocol_version,
        executor_version=capabilities.executor_version,
        driver_kinds_json=list(capabilities.driver_kinds),
        capabilities_json={
            "os": capabilities.os,
            "architecture": capabilities.architecture,
            "runtimes": dict(capabilities.runtimes),
        },
        max_concurrency=capabilities.max_concurrency,
        enrolled_at=now,
        created_at=now,
        updated_at=now,
    )
    session.add(executor)
    session.commit()
    session.refresh(executor)
    return executor, raw_credential, EXECUTOR_HEARTBEAT_SECONDS, ATTEMPT_LEASE_SECONDS


def _validate_enrollment_request(
    session: Session,
    token: ExecutorEnrollmentTokenDB,
    name: str,
    capabilities: ExecutorCapabilities,
) -> None:
    if not name.strip() or len(name.strip()) > 255:
        raise EnrollmentError(
            "capability_invalid",
            "executor name must be between 1 and 255 characters",
        )
    if capabilities.protocol_version not in SUPPORTED_EXECUTOR_PROTOCOL_VERSIONS:
        raise EnrollmentError(
            "protocol_mismatch",
            "executor protocol version is not supported",
        )
    if not 1 <= capabilities.max_concurrency <= 128:
        raise EnrollmentError(
            "capability_invalid",
            "max_concurrency must be between 1 and 128",
        )
    if token.executor_pool_id is None:
        return
    pool = session.get(ExecutorPoolDB, token.executor_pool_id)
    if (
        pool is None
        or not pool.enabled
        or pool.archived_at is not None
        or pool.required_driver_kind not in capabilities.driver_kinds
    ):
        raise EnrollmentError(
            "capability_invalid",
            "executor does not satisfy the target Pool requirements",
        )


def resolve_executor_by_credential(session: Session, raw_credential: str) -> ExecutorDB | None:
    """Resolve an enabled, non-revoked Executor by raw credential, else None."""
    if not raw_credential.startswith(_CREDENTIAL_PREFIX):
        return None
    cred_hash = _hash_with_salt(raw_credential)
    return session.exec(
        select(ExecutorDB).where(
            as_column(ExecutorDB.credential_hash) == cred_hash,
            as_column(ExecutorDB.enabled).is_(True),
            as_column(ExecutorDB.revoked_at).is_(None),
        )
    ).first()


# ── Attempt JWT ───────────────────────────────────────────────────────────


def create_attempt_jwt(
    *,
    attempt: TaskExecutionAttemptDB,
    lease_generation: int,
    expires_in_seconds: int,
) -> str:
    """Mint a ``task_execution_attempt`` JWT scoped to one Attempt+generation."""
    if not AUTH_SECRET:
        raise RuntimeError("AUTH_SECRET is not set; cannot issue Attempt JWT")
    expire = datetime.now(timezone.utc) + timedelta(seconds=expires_in_seconds)
    payload: dict[str, object] = {
        "typ": ATTEMPT_JWT_TYPE,
        "project": attempt.project,
        "task_run_id": attempt.task_run_id,
        "attempt_id": attempt.id,
        "executor_id": attempt.executor_id,
        "lease_generation": lease_generation,
        "permissions": [
            "attempt:start", "attempt:heartbeat", "attempt:finish",
            "attempt:bundle", "attempt:trace", "attempt:artifact",
        ],
        "exp": expire,
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, AUTH_SECRET, algorithm=ALGORITHM)


def decode_attempt_jwt(token: str) -> dict[str, object] | None:
    """Decode and validate an Attempt JWT. Returns claims or None."""
    if not AUTH_SECRET:
        return None
    try:
        payload: dict[str, object] = jwt.decode(token, AUTH_SECRET, algorithms=[ALGORITHM])
    except JWTError:
        return None
    if payload.get("typ") != ATTEMPT_JWT_TYPE:
        return None
    return payload


def validate_current_attempt_jwt(
    session: Session,
    token: str,
) -> tuple[TaskExecutionAttemptDB, dict[str, object]] | None:
    """Validate an Attempt JWT against the authoritative live lease.

    Signature and expiry validation are necessary but insufficient: a token
    from an expired/requeued lease must immediately lose trace and Artifact
    access. Every non-protocol request therefore checks all identity claims,
    the current generation and owner, and an active lease status.
    """
    claims = decode_attempt_jwt(token)
    if claims is None:
        return None

    attempt_id = claims.get("attempt_id")
    task_run_id = claims.get("task_run_id")
    project = claims.get("project")
    generation = claims.get("lease_generation")
    executor_id = claims.get("executor_id")
    if (
        not isinstance(attempt_id, str)
        or not isinstance(task_run_id, str)
        or not isinstance(project, str)
        or not isinstance(generation, int)
        or (executor_id is not None and not isinstance(executor_id, str))
    ):
        return None

    attempt = session.get(TaskExecutionAttemptDB, attempt_id)
    if attempt is None or attempt.status not in ("leased", "running"):
        return None
    if (
        attempt.lease_expires_at is None
        or attempt.lease_expires_at <= datetime.now(timezone.utc)
    ):
        return None
    if (
        attempt.task_run_id != task_run_id
        or attempt.project != project
        or attempt.lease_generation != generation
        or attempt.executor_id != executor_id
    ):
        return None
    return attempt, claims


# ── Lease constants ───────────────────────────
# Env-overridable per repo convention; defaults are the spec's constants.

EXECUTOR_HEARTBEAT_SECONDS = int(os.environ.get("APO_EXECUTOR_HEARTBEAT_SECONDS", "20"))
ATTEMPT_LEASE_SECONDS = int(os.environ.get("APO_ATTEMPT_LEASE_SECONDS", "90"))
EXECUTOR_OFFLINE_THRESHOLD_SECONDS = int(
    os.environ.get("APO_EXECUTOR_OFFLINE_THRESHOLD_SECONDS", "60")
)
REAPER_INTERVAL_SECONDS = int(os.environ.get("APO_EXECUTION_REAPER_INTERVAL_SECONDS", "15"))
EMPTY_CLAIM_RETRY_SECONDS = 2
DEFAULT_QUEUE_TTL_SECONDS = 86_400
CANCELLATION_GRACE_SECONDS = 10


__all__ = [
    "ATTEMPT_JWT_TYPE",
    "ATTEMPT_LEASE_SECONDS",
    "CANCELLATION_GRACE_SECONDS",
    "CredentialHashError",
    "DEFAULT_QUEUE_TTL_SECONDS",
    "EMPTY_CLAIM_RETRY_SECONDS",
    "EXECUTOR_HEARTBEAT_SECONDS",
    "EXECUTOR_OFFLINE_THRESHOLD_SECONDS",
    "EnrollmentError",
    "REAPER_INTERVAL_SECONDS",
    "create_attempt_jwt",
    "decode_attempt_jwt",
    "exchange_enrollment_token",
    "generate_credential",
    "generate_enrollment_token",
    "hash_credential",
    "resolve_executor_by_credential",
    "resolve_enrollment_token",
    "validate_current_attempt_jwt",
]
