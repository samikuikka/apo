"""Ingest guardrails: persisted daily quotas (per key and per account)
and per-key pause.

Enforcement runs on the ingest routes only, before any durable write:
a paused key gets 403 (collectors must not retry), an over-quota key or
account gets 429 with Retry-After to UTC midnight. The per-key quota and
pause read straight off ``request.state`` (populated by the auth
middleware from the cached key row, so PATCH invalidation applies
immediately); the account cap reads the environment at call time. Both
read today's counts from the usage tables through short-lived
in-process caches.

Accounting is single-statement UPSERT increments per accepted request,
one row per key and one row per account, and is deliberately NON-FATAL:
a failure after apo already accepted and committed the spans must not
turn into a 500 (the SDK would retry and re-send); an under-counted
usage row is the cheaper failure.

Threat model: per-key quotas guard against buggy exporters and retry
storms, not members or leaked keys (rotate is the compromise response).
The account cap (APO_USER_DAILY_SPAN_QUOTA) is the hosted-service lever:
per-key caps alone multiply by the number of minted keys (N keys = N x
cap), so the aggregate bounds what one admitted user's whole key fleet
can ingest per day.
"""

# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, Request
from sqlalchemy import text
from sqlmodel import Session

from ..models.db import ApiKeyDB

logger = logging.getLogger(__name__)

# Enforcement reads today's count at most this often per key or account;
# the window trades a little overshoot precision for one cached read per
# request.
_TODAY_COUNT_CACHE_TTL_SECONDS = 30.0

_lock = threading.Lock()
_today_counts: dict[str, tuple[str, int, float]] = {}  # key_id -> (day, spans, ts)
_today_user_counts: dict[str, tuple[str, int, float]] = {}  # user_id -> (day, spans, ts)


class _QuotaExceeded(HTTPException):
    """429 carrying the quota block collectors' humans can read."""

    def __init__(
        self, *, limit: int, used: int, reset_at: datetime, message: str
    ) -> None:
        retry_after = max(1, int((reset_at - datetime.now(timezone.utc)).total_seconds()))
        super().__init__(
            status_code=429,
            detail={
                "message": message,
                "quota": {
                    "limit": limit,
                    "used": used,
                    "reset_at": reset_at.isoformat(),
                },
            },
            headers={
                "Retry-After": str(retry_after),
                "X-RateLimit-Limit": str(limit),
                "X-RateLimit-Used": str(used),
                "X-RateLimit-Reset": reset_at.isoformat(),
            },
        )


def user_daily_span_quota() -> int:
    """Account-level daily span cap; 0/unset = off.

    Read per call (not import time) so operators can flip it with a
    restart-free env change on the next request and tests can monkeypatch
    it without module reloads.
    """
    try:
        return int(os.environ.get("APO_USER_DAILY_SPAN_QUOTA", "0"))
    except ValueError:
        return 0


def _utc_day(now: datetime | None = None) -> tuple[str, datetime]:
    """(today's "YYYY-MM-DD", the next UTC midnight)."""
    moment = now or datetime.now(timezone.utc)
    day = moment.strftime("%Y-%m-%d")
    reset = (moment + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return day, reset


def _today_spans(session: Session, api_key_id: str, day: str) -> int:
    cached = _today_counts.get(api_key_id)
    now = time.monotonic()
    if cached and cached[0] == day and now - cached[2] < _TODAY_COUNT_CACHE_TTL_SECONDS:
        return cached[1]
    row = session.execute(
        text("SELECT span_count FROM api_key_daily_usage WHERE api_key_id = :k AND day = :d"),
        {"k": api_key_id, "d": day},
    ).first()
    spans = int(row[0]) if row else 0
    with _lock:
        _today_counts[api_key_id] = (day, spans, now)
    return spans


def _today_user_spans(session: Session, user_id: str, day: str) -> int:
    cached = _today_user_counts.get(user_id)
    now = time.monotonic()
    if cached and cached[0] == day and now - cached[2] < _TODAY_COUNT_CACHE_TTL_SECONDS:
        return cached[1]
    row = session.execute(
        text("SELECT span_count FROM user_daily_usage WHERE user_id = :u AND day = :d"),
        {"u": user_id, "d": day},
    ).first()
    spans = int(row[0]) if row else 0
    with _lock:
        _today_user_counts[user_id] = (day, spans, now)
    return spans


def enforce_ingest_guardrails(
    request: Request, session: Session, *, pending_spans: int
) -> None:
    """Raise 403/429 when the calling key is paused, over its per-key
    quota, or over the account-level aggregate quota.

    No-op for non-key identities (service/attempt tokens, open-dev).
    Quotas compare today's ACCEPTED spans + this request's DECODED spans
    against the limit; a junk batch at the boundary can be rejected
    without being counted; accepted, documented behavior. The per-key
    check runs first so the tighter, more actionable cap answers.
    """
    api_key_id = getattr(request.state, "api_key_id", None)
    if api_key_id is None:
        return

    paused = getattr(request.state, "api_key_ingest_paused", False)
    if paused:
        raise HTTPException(
            status_code=403,
            detail="ingest is paused for this API key (resume it in project settings)",
        )

    key_quota = getattr(request.state, "api_key_daily_quota", None) or 0
    account_quota = user_daily_span_quota()
    if key_quota <= 0 and account_quota <= 0:
        return

    day, reset_at = _utc_day()
    if key_quota > 0:
        used = _today_spans(session, api_key_id, day)
        if used + pending_spans > key_quota:
            raise _QuotaExceeded(
                limit=key_quota,
                used=used,
                reset_at=reset_at,
                message="daily span quota exceeded for this API key",
            )

    if account_quota > 0:
        key_row = session.get(ApiKeyDB, api_key_id)
        user_id = key_row.created_by if key_row else None
        if user_id:
            used = _today_user_spans(session, user_id, day)
            if used + pending_spans > account_quota:
                raise _QuotaExceeded(
                    limit=account_quota,
                    used=used,
                    reset_at=reset_at,
                    message=(
                        "daily span quota exceeded for this account "
                        "(combined across its API keys)"
                    ),
                )


_KEY_USAGE_UPSERT = text(
    "INSERT INTO api_key_daily_usage "
    "(api_key_id, day, span_count, byte_count, request_count, updated_at) "
    "VALUES (:id, :d, :s, :b, 1, :now) "
    "ON CONFLICT (api_key_id, day) DO UPDATE SET "
    "span_count = span_count + :s, "
    "byte_count = byte_count + :b, "
    "request_count = request_count + 1, "
    "updated_at = :now"
)

_USER_USAGE_UPSERT = text(
    "INSERT INTO user_daily_usage "
    "(user_id, day, span_count, byte_count, request_count, updated_at) "
    "VALUES (:id, :d, :s, :b, 1, :now) "
    "ON CONFLICT (user_id, day) DO UPDATE SET "
    "span_count = span_count + :s, "
    "byte_count = byte_count + :b, "
    "request_count = request_count + 1, "
    "updated_at = :now"
)


def record_ingest_usage(
    session: Session,
    api_key_id: str | None,
    *,
    spans: int,
    bytes_: int,
) -> None:
    """UPSERT-increment today's usage rows: one per key, one per account.

    Never raises (non-fatal by design, see module docstring); owns its
    transactions. The two grains commit independently, so a failure
    recording the account row (for example a database that predates the
    aggregate table) never rolls back the per-key row, which is the exact
    record. The account row is keyed by the key's creator, read with one
    primary-key lookup so callers need no new plumbing.
    """
    if not api_key_id or (spans <= 0 and bytes_ <= 0):
        return
    day, _reset = _utc_day()
    positive_spans = max(spans, 0)
    positive_bytes = max(bytes_, 0)
    now = datetime.now(timezone.utc)

    try:
        with Session(session.bind) as own:
            own.execute(
                _KEY_USAGE_UPSERT,
                {
                    "id": api_key_id,
                    "d": day,
                    "s": positive_spans,
                    "b": positive_bytes,
                    "now": now,
                },
            )
            own.commit()
        with _lock:
            cached = _today_counts.get(api_key_id)
            if cached and cached[0] == day:
                _today_counts[api_key_id] = (day, cached[1] + positive_spans, time.monotonic())
    except Exception:  # noqa: BLE001 — accepted spans must not 500 on us
        logger.warning(
            "failed to record per-key ingest usage for key %s (accepted spans unaffected)",
            api_key_id,
            exc_info=True,
        )

    try:
        user_id: str | None = None
        with Session(session.bind) as own:
            owner_row = own.execute(
                text("SELECT created_by FROM api_keys WHERE id = :k"),
                {"k": api_key_id},
            ).first()
            if owner_row is not None and owner_row[0]:
                user_id = str(owner_row[0])
                own.execute(
                    _USER_USAGE_UPSERT,
                    {
                        "id": user_id,
                        "d": day,
                        "s": positive_spans,
                        "b": positive_bytes,
                        "now": now,
                    },
                )
            own.commit()
        if user_id is not None:
            with _lock:
                cached_user = _today_user_counts.get(user_id)
                if cached_user and cached_user[0] == day:
                    _today_user_counts[user_id] = (
                        day,
                        cached_user[1] + positive_spans,
                        time.monotonic(),
                    )
    except Exception:  # noqa: BLE001 — accepted spans must not 500 on us
        logger.warning(
            "failed to record account ingest usage for key %s (accepted spans unaffected)",
            api_key_id,
            exc_info=True,
        )


def today_usage(session: Session, api_key_id: str) -> dict[str, Any] | None:
    """Today's usage row for a key, for API responses (day/spans/bytes)."""
    day, _reset = _utc_day()
    row = session.execute(
        text(
            "SELECT span_count, byte_count FROM api_key_daily_usage "
            "WHERE api_key_id = :k AND day = :d"
        ),
        {"k": api_key_id, "d": day},
    ).first()
    if row is None:
        return {"day": day, "spans": 0, "bytes": 0}
    return {"day": day, "spans": int(row[0]), "bytes": int(row[1])}


def today_user_usage(session: Session, user_id: str) -> dict[str, Any] | None:
    """Today's aggregate usage row for an account, for API responses."""
    day, _reset = _utc_day()
    row = session.execute(
        text(
            "SELECT span_count, byte_count FROM user_daily_usage "
            "WHERE user_id = :u AND day = :d"
        ),
        {"u": user_id, "d": day},
    ).first()
    if row is None:
        return {"day": day, "spans": 0, "bytes": 0}
    return {"day": day, "spans": int(row[0]), "bytes": int(row[1])}
