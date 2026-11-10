# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false

"""Projection passes must give SQLite's write lock back between chunks.

Two starvation shapes, both pinned here:

- Reproject committed each 32-span chunk and immediately took the write
  lock again, so a client looping the reproject endpoint kept the lock for
  as long as it liked; heartbeats, OTLP accepts and every other writer
  queued behind busy_timeout and started failing. Every chunk now ends
  with a pause with the lock released. The probe below runs inside that
  pause, on its own connection with a 100 ms budget, and must win the
  lock every time.
- The projector recomputed a completed run's aggregates after every span,
  so a batch of N spans landing on a completed run cost N whole-run
  recomputations inside the write lock: quadratic per trace. The worker's
  batch pass and reproject now defer them and pay once per run per pass,
  while a caller projecting spans one at a time keeps the per-span
  behavior.
"""

from __future__ import annotations

import json
import sqlite3

import pytest
from _pytest.monkeypatch import MonkeyPatch
from sqlmodel import Session, select, text

import apo.services.reproject as reproject
import apo.services.trace_projector as trace_projector
from apo.db import DATABASE_URL, engine, reset_apo_file_db
from apo.models.db import OtlpSpanDB
from apo.services.otlp_receiver import OtlpReceiver
from apo.services.reproject import reproject_trace
from apo.services.trace_ingestion_queue import (
    PROJECTION_COMMIT_CHUNK,
    QueueWorker,
)
from apo.services.trace_projector import get_trace_projector

PROJECT = "lock-hygiene"
TRACE_ID = "c2240000000000000000000000000001"
ROOT_SPAN_ID = "c000000000000001"
# Fixed wall-clock anchor; span times are offsets from it.
BASE_NANOS = 1_791_907_200_000_000_000

Span = dict[str, object]


@pytest.fixture(autouse=True)
def clean_projection_tables():
    reset_apo_file_db()
    yield
    with Session(engine) as session:
        for table in (
            "call_metrics",
            "run_metrics",
            "logged_calls",
            "runs",
            "otlp_spans",
            "otlp_ingest_batches",
        ):
            session.execute(text(f"DELETE FROM {table}"))
        session.commit()


def test_reproject_leaves_the_write_lock_free_between_chunks(
    monkeypatch: MonkeyPatch,
) -> None:
    """Every chunk boundary must open an unlocked window another writer wins."""
    children = PROJECTION_COMMIT_CHUNK * 3
    _ingest([_root_span(), *(_tool_span(index) for index in range(children))])

    probes: list[bool] = []
    monkeypatch.setattr(
        reproject, "_pause_between_chunks", lambda: probes.append(_probe_takes_write_lock())
    )

    count = reproject_trace(TRACE_ID, project_id=PROJECT)

    assert count == children + 1
    assert len(probes) == count // PROJECTION_COMMIT_CHUNK
    assert all(probes), (
        f"{probes.count(False)} of {len(probes)} pauses still held the write lock"
    )


def test_worker_batch_aggregates_a_completed_run_once_per_pass(
    monkeypatch: MonkeyPatch,
) -> None:
    """One batch of spans landing on a completed run pays one aggregation."""
    aggregate_calls = _count_run_aggregate_calls(monkeypatch)
    children = 256
    batch_id = _ingest([_root_span(), *(_tool_span(index) for index in range(children))])

    outcome = QueueWorker(receiver=OtlpReceiver())._process_batch(batch_id)

    assert outcome.rejected == 0, outcome.errors[:3]
    assert outcome.projected == children + 1
    assert len(aggregate_calls) == 1, (
        "a completed run was re-aggregated per span inside the batch pass"
    )


def test_inline_projection_still_aggregates_per_span(
    monkeypatch: MonkeyPatch,
) -> None:
    """Callers projecting single spans outside a pass keep today's behavior."""
    aggregate_calls = _count_run_aggregate_calls(monkeypatch)
    _ingest([_root_span(), *(_tool_span(index) for index in range(3))])

    projector = get_trace_projector()
    with Session(engine) as session:
        canonical = session.exec(
            select(OtlpSpanDB)
            .where(OtlpSpanDB.trace_id == TRACE_ID, OtlpSpanDB.project_id == PROJECT)
            .order_by(text("id"))
        ).all()
        assert len(canonical) == 4
        for span in canonical:
            projector.project(span, session)
        session.commit()

    assert len(aggregate_calls) == 4


def _count_run_aggregate_calls(
    monkeypatch: MonkeyPatch,
) -> list[str]:
    """Record every whole-run aggregate recomputation, then run the real one."""
    calls: list[str] = []
    original = trace_projector._compute_run_aggregates

    def counting(session: Session, trace_id: str, project: str) -> None:
        calls.append(trace_id)
        original(session, trace_id, project)

    monkeypatch.setattr(trace_projector, "_compute_run_aggregates", counting)
    return calls


def _probe_takes_write_lock() -> bool:
    """BEGIN IMMEDIATE on a fresh connection with a 100 ms budget.

    True when the write lock was free; False when another connection held
    it for the whole budget (the back-to-back reproject shape).
    """
    connection = sqlite3.connect(_db_path(), timeout=0.1)
    try:
        connection.execute("PRAGMA busy_timeout=100")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("COMMIT")
        return True
    except sqlite3.OperationalError:
        return False
    finally:
        connection.close()


def _db_path() -> str:
    url = DATABASE_URL
    assert url.startswith("sqlite:///"), "the probe needs the file-backed test DB"
    return url[len("sqlite:///") :]


def _ingest(spans: list[Span]) -> str:
    """Accept spans canonically (no projection) and return the batch id."""
    payload = json.dumps(
        {
            "resourceSpans": [
                {
                    "resource": {
                        "attributes": [_attribute("service.name", "hygiene-svc")]
                    },
                    "scopeSpans": [{"scope": {"name": "hygiene"}, "spans": spans}],
                }
            ]
        }
    ).encode()
    receiver = OtlpReceiver()
    with Session(engine) as session:
        result = receiver.ingest(
            payload=payload,
            content_type="application/json",
            project_id=PROJECT,
            session=session,
            project_immediately=False,
        )
    assert result.rejected == 0, result.errors[:3]
    return result.batch_id


def _root_span() -> Span:
    return _span(ROOT_SPAN_ID, None, "agent run", 0, 60_000, "AGENT")


def _tool_span(index: int) -> Span:
    start = 1_000 + index * 10
    return _span(
        f"c0000000000001{index:02x}",
        ROOT_SPAN_ID,
        "execute_tool bash",
        start,
        start + 5,
        "TOOL",
    )


def _span(
    span_id: str,
    parent: str | None,
    name: str,
    start_ms: int,
    end_ms: int,
    observation_type: str,
) -> Span:
    span: Span = {
        "traceId": TRACE_ID,
        "spanId": span_id,
        "name": name,
        "kind": 1,
        "startTimeUnixNano": str(BASE_NANOS + start_ms * 1_000_000),
        "endTimeUnixNano": str(BASE_NANOS + end_ms * 1_000_000),
        "attributes": [
            {
                "key": "apo.observation.type",
                "value": {"stringValue": observation_type},
            }
        ],
    }
    if parent is not None:
        span["parentSpanId"] = parent
    return span


def _attribute(key: str, value: object) -> dict[str, object]:
    return {"key": key, "value": {"stringValue": str(value)}}
