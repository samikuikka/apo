"""Ingest guardrails — persisted per-key daily quotas and pause ).

Enforcement runs on the ingest routes only, before any durable write:
a paused key gets 403 (collectors must not retry), an over-quota key gets
429 with Retry-After to UTC midnight. Both read quota/pause straight off
``request.state`` (populated by the auth middleware from the cached key
row — so PATCH invalidation applies immediately) and today's span count
from the usage table through a short-lived in-process cache.

Accounting is a single-statement UPSERT increment per accepted request and
is deliberately NON-FATAL: a failure after apo already accepted and
committed the spans must not turn into a 500 (the SDK would retry and
re-send); an under-counted usage row is the cheaper failure.

Threat model: quotas guard against buggy exporters and retry storms —
not members or leaked keys (rotate is the compromise response). The quota
grain is one key; N keys = N x cap.
"""

# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, Request
from sqlalchemy import text
from sqlmodel import Session

logger = logging.getLogger(__name__)

# Enforcement reads today's count at most this often per key; the window
# trades a little overshoot precision for one cached read per request.
_TODAY_COUNT_CACHE_TTL_SECONDS = 30.0

_lock = threading.Lock()
_today_counts: dict[str, tuple[str, int, float]] = {}  # key_id -> (day, spans, ts)


class _QuotaExceeded(HTTPException):
    """429 carrying the quota block collectors' humans can read."""

    def __init__(self, *, limit: int, used: int, reset_at: datetime) -> None:
        retry_after = max(1, int((reset_at - datetime.now(timezone.utc)).total_seconds()))
        super().__init__(
            status_code=429,
            detail={
                "message": "daily span quota exceeded for this API key",
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


def enforce_ingest_guardrails(
    request: Request, session: Session, *, pending_spans: int
) -> None:
    """Raise 403/429 when the calling key is paused or over quota.

    No-op for non-key identities (service/attempt tokens, open-dev).
    Quota compares today's ACCEPTED spans + this request's DECODED spans
    against the limit — a junk batch at the boundary can be rejected
    without being counted; accepted, documented behavior.
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

    quota = getattr(request.state, "api_key_daily_quota", None)
    if not quota or quota <= 0:
        return

    day, reset_at = _utc_day()
    used = _today_spans(session, api_key_id, day)
    if used + pending_spans > quota:
        raise _QuotaExceeded(limit=quota, used=used, reset_at=reset_at)


def record_ingest_usage(
    session: Session,
    api_key_id: str | None,
    *,
    spans: int,
    bytes_: int,
) -> None:
    """UPSERT-increment today's usage row. Never raises (non-fatal by
    design — see module docstring); owns its transaction."""
    if not api_key_id or (spans <= 0 and bytes_ <= 0):
        return
    day, _reset = _utc_day()
    try:
        with Session(session.bind) as own:
            own.execute(
                text(
                    "INSERT INTO api_key_daily_usage "
                    "(api_key_id, day, span_count, byte_count, request_count, updated_at) "
                    "VALUES (:k, :d, :s, :b, 1, :now) "
                    "ON CONFLICT (api_key_id, day) DO UPDATE SET "
                    "span_count = span_count + :s, "
                    "byte_count = byte_count + :b, "
                    "request_count = request_count + 1, "
                    "updated_at = :now"
                ),
                {
                    "k": api_key_id,
                    "d": day,
                    "s": max(spans, 0),
                    "b": max(bytes_, 0),
                    "now": datetime.now(timezone.utc),
                },
            )
            own.commit()
        with _lock:
            cached = _today_counts.get(api_key_id)
            if cached and cached[0] == day:
                _today_counts[api_key_id] = (
                    day,
                    cached[1] + max(spans, 0),
                    time.monotonic(),
                )
    except Exception:  # noqa: BLE001 — accepted spans must not 500 on us
        logger.warning(
            "failed to record ingest usage for key %s (accepted spans unaffected)",
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
