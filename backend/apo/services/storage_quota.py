"""Project-level storage guardrail: a daily byte budget for accepted
Deliverable and result-evidence upload obligations.

The artifact and evidence paths cap per item, per run, and per attempt,
but no existing cap bounds the SUM across a project's many runs, so one
tenant can fill the disk with politely small uploads forever. This quota
bounds the daily flow: every accepted upload intent (declared size)
counts into one row per (project, UTC day), and a project over budget
gets 429 with Retry-After to UTC midnight, the same contract as the span
quotas in ingest_quota.

Accounting counts the accepted OBLIGATION at intent time rather than
streamed bytes, so enforcement and the counter agree exactly; an
abandoned pending upload over-counts conservatively for that day only
(pending slots expire through their own TTLs). Retention sweeps bound
the stock of stored bytes; this bounds the flow. Recording is
deliberately NON-FATAL, same philosophy as ingest accounting: a failed
counter write must never fail an already-accepted upload.
"""

# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import text
from sqlmodel import Session

logger = logging.getLogger(__name__)

# Enforcement reads today's byte total at most this often per project;
# the window trades a little overshoot precision for one cached read per
# intent.
_TODAY_BYTES_CACHE_TTL_SECONDS = 30.0

_lock = threading.Lock()
_today_bytes: dict[str, tuple[str, int, float]] = {}  # project_id -> (day, bytes, ts)


def project_daily_storage_quota() -> int:
    """Project-level bytes/day cap; 0/unset = off.

    Read per call (not import time) so operators can flip it without a
    restart and tests can monkeypatch it without module reloads.
    """
    try:
        return int(os.environ.get("APO_PROJECT_DAILY_STORAGE_QUOTA", "0"))
    except ValueError:
        return 0


def _utc_day(now: datetime | None = None) -> tuple[str, datetime]:
    """(today's "YYYY-MM-DD", the next UTC midnight)."""
    moment = now or datetime.now(timezone.utc)
    day = moment.strftime("%Y-%m-%d")
    reset = (moment + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return day, reset


class _StorageQuotaExceeded(HTTPException):
    """429 carrying the quota block runners' humans can read."""

    def __init__(self, *, limit: int, used: int, reset_at: datetime) -> None:
        retry_after = max(1, int((reset_at - datetime.now(timezone.utc)).total_seconds()))
        super().__init__(
            status_code=429,
            detail={
                "message": (
                    "daily storage quota exceeded for this project "
                    "(deliverables and result evidence combined)"
                ),
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


def _today_project_bytes(session: Session, project_id: str, day: str) -> int:
    cached = _today_bytes.get(project_id)
    now = time.monotonic()
    if cached and cached[0] == day and now - cached[2] < _TODAY_BYTES_CACHE_TTL_SECONDS:
        return cached[1]
    try:
        row = session.execute(
            text(
                "SELECT byte_count FROM project_daily_usage "
                "WHERE project_id = :p AND day = :d"
            ),
            {"p": project_id, "d": day},
        ).first()
    except Exception:  # noqa: BLE001 — a missing counter table must not 500 uploads
        # Fail open: without the rollup table there is nothing counted yet,
        # and blocking every upload over a bookkeeping table would be the
        # worse failure. The record path logs the same condition.
        logger.warning(
            "cannot read project storage usage for %s (treating as 0)",
            project_id,
            exc_info=True,
        )
        return 0
    used = int(row[0]) if row else 0
    with _lock:
        _today_bytes[project_id] = (day, used, now)
    return used


def enforce_project_storage_quota(
    session: Session, *, project_id: str, pending_bytes: int
) -> None:
    """Raise 429 when the project's accepted upload obligations plus
    this one exceed the daily byte budget. No-op when the knob is off."""
    quota = project_daily_storage_quota()
    if quota <= 0:
        return
    day, reset_at = _utc_day()
    used = _today_project_bytes(session, project_id, day)
    if used + pending_bytes > quota:
        raise _StorageQuotaExceeded(limit=quota, used=used, reset_at=reset_at)


def record_project_storage(session: Session, project_id: str, *, size_bytes: int) -> None:
    """UPSERT-increment today's project storage row. Never raises
    (non-fatal by design, see module docstring); owns its transaction."""
    if not project_id or size_bytes <= 0:
        return
    day, _reset = _utc_day()
    try:
        with Session(session.bind) as own:
            own.execute(
                text(
                    "INSERT INTO project_daily_usage "
                    "(project_id, day, byte_count, request_count, updated_at) "
                    "VALUES (:p, :d, :b, 1, :now) "
                    "ON CONFLICT (project_id, day) DO UPDATE SET "
                    "byte_count = byte_count + :b, "
                    "request_count = request_count + 1, "
                    "updated_at = :now"
                ),
                {
                    "p": project_id,
                    "d": day,
                    "b": size_bytes,
                    "now": datetime.now(timezone.utc),
                },
            )
            own.commit()
        with _lock:
            cached = _today_bytes.get(project_id)
            if cached and cached[0] == day:
                _today_bytes[project_id] = (day, cached[1] + size_bytes, time.monotonic())
    except Exception:  # noqa: BLE001 — an accepted upload must not fail on us
        logger.warning(
            "failed to record storage usage for project %s (accepted upload unaffected)",
            project_id,
            exc_info=True,
        )


def today_project_storage(session: Session, project_id: str) -> dict[str, Any] | None:
    """Today's storage usage for a project, for API responses and tests."""
    day, _reset = _utc_day()
    row = session.execute(
        text(
            "SELECT byte_count FROM project_daily_usage "
            "WHERE project_id = :p AND day = :d"
        ),
        {"p": project_id, "d": day},
    ).first()
    if row is None:
        return {"day": day, "bytes": 0}
    return {"day": day, "bytes": int(row[0])}
