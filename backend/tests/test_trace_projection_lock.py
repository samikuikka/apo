# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false

"""Concurrent OTLP projection must not lose accepted spans to lock contention.

Proven failure (load test, 5 workers x 4 requests x 256 spans): the
projector's SAVEPOINT-opened deferred transaction does reads (run/call
lookups) and then writes. Under concurrent writers that write needs a WAL
snapshot upgrade, which SQLite refuses instantly with SQLITE_BUSY_SNAPSHOT
— the busy_timeout is never consulted. The per-span savepoint handler
counted the span "rejected", the batch went partial, and nothing retries
partial batches: spans the receiver had accepted never reached
runs/logged_calls. Silent loss from the client's point of view.

This test drives the real accept path (``OtlpReceiver.ingest``) and the
real projection path (``QueueWorker._process_batch``) concurrently against
``apo.db.engine`` (a per-process WAL file DB, same pragmas as production).
Every accepted span must project; a "database is locked" outcome anywhere
is a failure, not a rejection.
"""

import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

import pytest
from sqlalchemy.exc import OperationalError
from sqlmodel import Session, select

from apo.db import engine
from apo.models.db import LoggedCallDB, OtlpIngestBatchDB, ProjectDB
from apo.services.otlp_receiver import OtlpReceiver
from apo.services.reproject import reproject_trace
from apo.services.trace_ingestion_queue import QueueWorker

PROJECT = "lock-repro"
WORKERS = 4
BATCHES_PER_WORKER = 2
SPANS_PER_BATCH = 128


def _ensure_project(project: str = PROJECT) -> None:
    with Session(engine) as session:
        if session.get(ProjectDB, project) is None:
            session.add(ProjectDB(id=project, name=project))
            session.commit()


def _span(trace: str, span_id: str, parent: str | None, i: int) -> dict[str, object]:
    attrs: list[dict[str, object]] = [
        {"key": "apo.observation.type", "value": {"stringValue": "TOOL"}},
        {"key": "gen_ai.tool.name", "value": {"stringValue": "bash"}},
    ]
    return {
        "traceId": trace,
        "spanId": span_id,
        "parentSpanId": parent,
        "name": f"step {i}",
        "kind": 1,
        "startTimeUnixNano": str(1_791_907_200_000_000_000 + i * 1_000_000),
        "endTimeUnixNano": str(1_791_907_200_000_000_000 + i * 1_000_000 + 900_000),
        "attributes": attrs,
    }


def _payload(worker: int, batch: int) -> bytes:
    trace = f"a{worker:02x}{batch:02x}".ljust(32, "0")[:32]
    root = f"b{worker:02x}{batch:02x}".ljust(16, "0")[:16]
    spans = [
        {
            "traceId": trace,
            "spanId": root,
            "name": "agent run",
            "kind": 1,
            "startTimeUnixNano": "1791907200000000000",
            "endTimeUnixNano": "1791907201000000000",
            "attributes": [
                {
                    "key": "apo.observation.type",
                    "value": {"stringValue": "AGENT"},
                },
                {"key": "apo.trace.name", "value": {"stringValue": "lock repro"}},
            ],
        }
    ]
    spans += [
        _span(trace, f"c{worker:02x}{batch:02x}{i:04x}".ljust(16, "0")[:16], root, i)
        for i in range(SPANS_PER_BATCH - 1)
    ]
    import json

    return json.dumps(
        {
            "resourceSpans": [
                {
                    "resource": {
                        "attributes": [
                            {
                                "key": "service.name",
                                "value": {"stringValue": "lock-repro-svc"},
                            }
                        ]
                    },
                    "scopeSpans": [{"scope": {"name": "t"}, "spans": spans}],
                }
            ]
        }
    ).encode()


def _accept_all() -> list[str]:
    """Accept WORKERS x BATCHES_PER_WORKER batches, threads in parallel."""
    receiver = OtlpReceiver()
    payloads = [
        _payload(w, b) for w in range(WORKERS) for b in range(BATCHES_PER_WORKER)
    ]
    batch_ids: list[str] = []
    lock = threading.Lock()

    def accept(payload: bytes) -> None:
        with Session(engine) as session:
            result = receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id=PROJECT,
                session=session,
                project_immediately=False,
            )
            assert result.rejected == 0, f"accept rejected spans: {result.errors[:3]}"
            with lock:
                batch_ids.append(result.batch_id)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        list(pool.map(accept, payloads))
    return batch_ids


def test_concurrent_projection_loses_no_accepted_spans() -> None:
    _ensure_project()
    batch_ids = _accept_all()
    total_spans = WORKERS * BATCHES_PER_WORKER * SPANS_PER_BATCH

    worker = QueueWorker(receiver=OtlpReceiver())

    # First projection pass (sequential, no contention) lands every span.
    for batch_id in batch_ids:
        result = worker._process_batch(batch_id)
        assert result.rejected == 0, f"sequential pass rejected: {result.errors[:3]}"
        assert result.projected == SPANS_PER_BATCH

    # Replay pass: OTLP exporters retry, so batches legitimately re-project.
    # Every span is now an update (SELECT the call, then UPDATE it) inside a
    # savepoint — the exact read-then-write window that loses spans to
    # SQLITE_BUSY_SNAPSHOT when writers run concurrently.
    start = threading.Barrier(WORKERS)

    def project(batch_id: str) -> tuple[int, int, str]:
        start.wait(timeout=60)
        result = worker._process_batch(batch_id)
        return result.projected, result.rejected, "; ".join(result.errors)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        results = list(pool.map(project, batch_ids * 2))

    locked = [e for _, _, errs in results for e in [errs] if "database is locked" in e]
    projected = sum(p for p, _, _ in results)
    rejected = sum(r for _, r, _ in results)
    assert not locked, f"write-lock contention surfaced as rejection: {locked[0][:300]}"
    assert rejected == 0, f"spans rejected during projection: {results}"
    assert projected == total_spans * 2, (
        f"projected {projected} != accepted replay {total_spans * 2}"
    )

    with Session(engine) as session:
        calls = session.exec(
            select(LoggedCallDB).where(LoggedCallDB.project == PROJECT)
        ).all()
    assert len(calls) == total_spans, (
        f"projected calls {len(calls)} != accepted spans {total_spans} "
        "(replay must update in place, never duplicate or drop)"
    )


def test_concurrent_reproject_does_not_under_project() -> None:
    """Concurrent reproject against a live writer must project every span.

    reproject_trace runs a whole trace through one Session against the live
    engine while the ingestion queue commits competing projection batches.
    Every thread must return exactly the span count (a swallowed lock
    failure would silently under-project) and logged_calls must stay at the
    span count: replay updates in place, never drops or duplicates.
    """
    project = "reproject-lock"
    _ensure_project(project)
    receiver = OtlpReceiver()
    with Session(engine) as session:
        accepted = receiver.ingest(
            payload=_payload(7, 7),
            content_type="application/json",
            project_id=project,
            session=session,
            project_immediately=False,
        )
    assert accepted.rejected == 0
    trace_id = f"a{7:02x}{7:02x}".ljust(32, "0")[:32]

    # First pass lands every span sequentially; from here all projections
    # take the update path (SELECT the call, then UPDATE it).
    worker = QueueWorker(receiver=OtlpReceiver())
    sequential = worker._process_batch(accepted.batch_id)
    assert sequential.rejected == 0, f"sequential pass rejected: {sequential.errors[:3]}"
    assert sequential.projected == SPANS_PER_BATCH

    # 3 reproject threads race 1 competing projection batch on the same
    # trace; the barrier maximizes the read-then-write overlap window.
    start = threading.Barrier(4)

    def reproject() -> int:
        start.wait(timeout=60)
        return reproject_trace(trace_id, project_id=project)

    def compete() -> tuple[int, int, str]:
        start.wait(timeout=60)
        result = worker._process_batch(accepted.batch_id)
        return result.projected, result.rejected, "; ".join(result.errors)

    with ThreadPoolExecutor(max_workers=4) as pool:
        reproject_futures = [pool.submit(reproject) for _ in range(3)]
        compete_future = pool.submit(compete)

    counts = [future.result() for future in reproject_futures]
    for count in counts:
        assert count == SPANS_PER_BATCH, (
            f"reproject projected {count} != {SPANS_PER_BATCH} canonical "
            "spans (under-projection while a competing writer commits)"
        )
    projected, rejected, errors = compete_future.result()
    assert rejected == 0, f"competing batch rejected spans: {errors[:300]}"
    assert projected == SPANS_PER_BATCH

    with Session(engine) as session:
        calls = session.exec(
            select(LoggedCallDB).where(LoggedCallDB.project == project)
        ).all()
    assert len(calls) == SPANS_PER_BATCH, (
        f"projected calls {len(calls)} != accepted spans {SPANS_PER_BATCH} "
        "(concurrent replay must update in place, never duplicate or drop)"
    )


def _locked_operational_error() -> OperationalError:
    """The exact error SQLite raises through SQLAlchemy on lock exhaustion."""
    return OperationalError(
        "BEGIN IMMEDIATE", {}, sqlite3.OperationalError("database is locked")
    )


@pytest.mark.asyncio
async def test_write_lock_contention_requeues_instead_of_failing() -> None:
    """A projection that loses the write-lock race must return to the queue.

    Terminal 'failed' batches are never retried, so marking one failed for
    transient lock contention silently drops every span the receiver
    accepted in it.
    """
    _ensure_project()
    receiver = OtlpReceiver()
    with Session(engine) as session:
        result = receiver.ingest(
            payload=_payload(9, 9),
            content_type="application/json",
            project_id=PROJECT,
            session=session,
            project_immediately=False,
        )
    assert result.rejected == 0

    worker = QueueWorker(receiver=receiver)
    with mock.patch.object(
        QueueWorker, "_process_batch", side_effect=_locked_operational_error()
    ):
        await worker._process_claimed(result.batch_id)

    with Session(engine) as session:
        batch = session.get(OtlpIngestBatchDB, result.batch_id)
    assert batch is not None
    assert batch.status == "queued", (
        f"lock contention must requeue, got '{batch.status}': {batch.error_message}"
    )


@pytest.mark.asyncio
async def test_non_lock_errors_still_fail_the_batch() -> None:
    """The requeue path is for lock contention only; real errors terminate."""
    _ensure_project()
    receiver = OtlpReceiver()
    with Session(engine) as session:
        result = receiver.ingest(
            payload=_payload(8, 8),
            content_type="application/json",
            project_id=PROJECT,
            session=session,
            project_immediately=False,
        )

    worker = QueueWorker(receiver=receiver)
    with mock.patch.object(
        QueueWorker, "_process_batch", side_effect=RuntimeError("corrupt payload")
    ):
        await worker._process_claimed(result.batch_id)

    with Session(engine) as session:
        batch = session.get(OtlpIngestBatchDB, result.batch_id)
    assert batch is not None
    assert batch.status == "failed"
    assert "corrupt payload" in (batch.error_message or "")
