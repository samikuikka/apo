# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false

"""Tests for the trace-quality latency fix.

SPEC-122 follow-up: the SDK historically reported ``latency_ms: 0`` for
any span that completed within the same millisecond tick. The backend
now derives latency from ``end_time - created_at`` when the SDK omits
``latency_ms`` (and has ``end_time`` available).
"""

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from sqlmodel import Session, select

from apo.models.db import LoggedCallDB
from apo.services.ingestion import process_call_create, process_call_update


def _make_call_create_body(
    *,
    call_id: str = "call-1",
    created_at: datetime | None = None,
    end_time: datetime | None = None,
    latency_ms: float | None = None,
    project: str = "test-project",
) -> dict[str, object]:
    body: dict[str, object] = {
        "id": call_id,
        "project": project,
        "task_id": "test-task",
        "model": "test-model",
        "observation_type": "GENERATION",
        "input": {},
    }
    if created_at is not None:
        body["created_at"] = created_at.isoformat()
    if end_time is not None:
        body["end_time"] = end_time.isoformat()
    if latency_ms is not None:
        body["latency_ms"] = latency_ms
    return body


class TestLatencyFromTimestamps:
    """Backend should derive latency_ms from timestamps when SDK omits it."""

    @pytest.mark.asyncio
    async def test_latency_derived_when_omitted(self, session: Session) -> None:
        """SDK sends no ``latency_ms`` but does send ``end_time`` → derive it."""
        started = datetime(2026, 6, 22, 12, 0, 0, tzinfo=timezone.utc)
        ended = started + timedelta(milliseconds=250)
        body = _make_call_create_body(created_at=started, end_time=ended)

        await process_call_create(body, session)

        call = session.exec(select(LoggedCallDB).where(LoggedCallDB.id == "call-1")).first()
        assert call is not None
        assert call.latency_ms is not None
        assert call.latency_ms == pytest.approx(250.0, abs=0.01)

    @pytest.mark.asyncio
    async def test_explicit_latency_preferred_over_timestamps(
        self, session: Session
    ) -> None:
        """SDK sends explicit ``latency_ms`` → use it as-is, even if 0."""
        started = datetime(2026, 6, 22, 12, 0, 0, tzinfo=timezone.utc)
        ended = started + timedelta(milliseconds=250)
        body = _make_call_create_body(
            created_at=started, end_time=ended, latency_ms=0.0
        )

        await process_call_create(body, session)

        call = session.exec(select(LoggedCallDB).where(LoggedCallDB.id == "call-1")).first()
        assert call is not None
        # Explicit value (even 0) wins — we only fall back when latency
        # is missing entirely.
        assert call.latency_ms == 0.0

    @pytest.mark.asyncio
    async def test_latency_null_when_no_timestamps(self, session: Session) -> None:
        """SDK sends neither ``latency_ms`` nor ``end_time`` → store None."""
        body = _make_call_create_body()

        await process_call_create(body, session)

        call = session.exec(select(LoggedCallDB).where(LoggedCallDB.id == "call-1")).first()
        assert call is not None
        assert call.latency_ms is None

    @pytest.mark.asyncio
    async def test_latency_derived_on_call_update(self, session: Session) -> None:
        """``call-update`` should also derive latency when omitted.

        This is the common case: SDK sends ``call-create`` without
        ``end_time`` (the span is still in flight), then ``call-update``
        with ``end_time`` when the span finishes. The backend should
        back-fill ``latency_ms`` from the timestamps.
        """
        started = datetime(2026, 6, 22, 12, 0, 0, tzinfo=timezone.utc)
        create_body = _make_call_create_body(created_at=started)
        await process_call_create(create_body, session)

        ended = started + timedelta(milliseconds=500)
        update_body: dict[str, object] = {
            "id": "call-1",
            "project": "test-project",
            "end_time": ended.isoformat(),
            "output": {"text": "done"},
        }
        await process_call_update(update_body, session)

        call = session.exec(select(LoggedCallDB).where(LoggedCallDB.id == "call-1")).first()
        assert call is not None
        assert call.latency_ms is not None
        assert call.latency_ms == pytest.approx(500.0, abs=0.01)

    @pytest.mark.asyncio
    async def test_zero_latency_when_start_equals_end(self, session: Session) -> None:
        """Genuinely-zero durations (same timestamp) are preserved, not faked."""
        same = datetime(2026, 6, 22, 12, 0, 0, tzinfo=timezone.utc)
        body = _make_call_create_body(created_at=same, end_time=same)

        await process_call_create(body, session)

        call = session.exec(select(LoggedCallDB).where(LoggedCallDB.id == "call-1")).first()
        assert call is not None
        # Real zero (timestamps match) is reported as 0 — we're not
        # fabricating durations, only recovering from missing data.
        assert call.latency_ms == 0.0

    @pytest.mark.asyncio
    async def test_sub_millisecond_duration_preserved(self, session: Session) -> None:
        """Durations under 1ms should not be rounded to 0."""
        started = datetime(2026, 6, 22, 12, 0, 0, tzinfo=timezone.utc)
        ended = started + timedelta(microseconds=500)  # 0.5ms
        body = _make_call_create_body(created_at=started, end_time=ended)

        await process_call_create(body, session)

        call = session.exec(select(LoggedCallDB).where(LoggedCallDB.id == "call-1")).first()
        assert call is not None
        assert call.latency_ms is not None
        assert call.latency_ms == pytest.approx(0.5, abs=0.01)
        assert call.latency_ms > 0
