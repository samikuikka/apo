"""Durable trace ingestion queue.

Decouples OTLP acceptance from projection. The receiver persists the raw
batch, enqueues its ``batch_id``, and returns an OTLP response immediately.
A worker claims batches from the queue, processes them (persist canonical
spans + project into product tables), and marks them complete or failed.

First implementation is DB-backed (polling via status field on
``OtlpIngestBatchDB``). Replaceable with Redis/SQS without changing the
protocol — just swap ``DbBackedQueue`` for ``RedisQueue`` etc.

Status lifecycle:
    accepted → queued → processing → projected (success)
                                   → failed (error, can be re-enqueued for retry)
"""

# pyright: reportAny=false, reportUnusedCallResult=false

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Protocol

from sqlalchemy import func
from sqlmodel import Session, col, select, update

from ..db import engine
from ..models.db import OtlpIngestBatchDB, OtlpSpanDB
from .otlp_receiver import OtlpReceiver

logger = logging.getLogger(__name__)
QUEUE_LEASE_SECONDS = int(os.environ.get("APO_TRACE_QUEUE_LEASE_SECONDS", "300"))


class TraceIngestionQueue(Protocol):
    """Protocol for the trace ingestion queue.

    Implementations may be DB-backed (default), Redis-backed, or SQS-backed.
    The receiver and worker depend only on this interface.
    """

    async def enqueue(self, batch_id: str) -> None:
        """Mark a batch as ready for processing."""
        ...

    async def claim_next(self) -> str | None:
        """Atomically claim the oldest queued batch.

        Returns the batch_id, or None if the queue is empty.
        Marks the batch as ``processing`` so other workers don't pick it up.
        """
        ...

    async def claim(self, batch_id: str) -> bool:
        """Atomically claim one exact queued batch."""
        ...

    async def mark_complete(self, batch_id: str) -> None:
        """Mark a batch as successfully projected."""
        ...

    async def mark_failed(
        self, batch_id: str, error: str, rejected: int = 0
    ) -> None:
        """Mark a batch as failed. Can be re-enqueued for retry."""
        ...

    async def mark_partial(
        self, batch_id: str, rejected: int, error: str
    ) -> None:
        """Mark a batch projected with one or more derived failures."""
        ...

    async def recover_stale(self) -> int:
        """Requeue processing batches whose worker lease expired."""
        ...


@dataclass(frozen=True)
class BatchProjectionResult:
    projected: int
    rejected: int
    errors: tuple[str, ...]


class DbBackedQueue:
    """DB-backed implementation using ``OtlpIngestBatchDB.status`` as the queue.

    No external Redis/SQS needed — works with SQLite and Postgres. Polling-
    based: the worker calls ``claim_next`` in a loop. For high-volume
    deployments, swap this for a ``RedisQueue`` that implements the same
    protocol.
    """

    async def enqueue(self, batch_id: str) -> None:
        """Set batch status to 'queued' so the worker can find it."""
        with Session(engine) as session:
            session.exec(
                update(OtlpIngestBatchDB)
                .where(col(OtlpIngestBatchDB.id) == batch_id)
                .values(
                    status="queued",
                    error_message=None,
                    processing_started_at=None,
                )
            )
            session.commit()

    async def claim_next(self) -> str | None:
        """Atomically claim the oldest 'queued' batch.

        Uses a single conditional UPDATE with RETURNING to ensure atomicity
        even under concurrent workers. The UPDATE only succeeds if the row
        is still 'queued', and we check the rowcount to confirm ownership.
        """
        with Session(engine) as session:
            batch = session.exec(
                select(OtlpIngestBatchDB)
                .where(col(OtlpIngestBatchDB.status) == "queued")
                .order_by(col(OtlpIngestBatchDB.received_at))
            ).first()

            if batch is None:
                return None

            result = session.exec(
                update(OtlpIngestBatchDB)
                .where(
                    col(OtlpIngestBatchDB.id) == batch.id,
                    col(OtlpIngestBatchDB.status) == "queued",
                )
                .values(
                    status="processing",
                    processing_started_at=datetime.now(timezone.utc),
                )
            )

            # Check rowcount — if 0, another worker claimed it first
            if result.rowcount == 0:
                return None

            session.commit()
            return batch.id

    async def claim(self, batch_id: str) -> bool:
        """Claim ``batch_id`` only when it is currently queued."""
        with Session(engine) as session:
            result = session.exec(
                update(OtlpIngestBatchDB)
                .where(
                    col(OtlpIngestBatchDB.id) == batch_id,
                    col(OtlpIngestBatchDB.status) == "queued",
                )
                .values(
                    status="processing",
                    processing_started_at=datetime.now(timezone.utc),
                )
            )
            if result.rowcount == 0:
                return False
            session.commit()
            return True

    async def mark_complete(self, batch_id: str) -> None:
        """Mark a batch as 'projected' and drop its replay payload.

        Projection success is the payload's whole job: the canonical span
        store is the source of truth (``reproject`` never reads payloads),
        so the full decoded request stops being a second copy of every
        span the moment it is no longer needed for crash replay. One
        UPDATE keeps the status flip and the blanking atomic — a crash
        between them cannot leave a 'projected' batch holding its payload.
        """
        with Session(engine) as session:
            session.exec(
                update(OtlpIngestBatchDB)
                .where(col(OtlpIngestBatchDB.id) == batch_id)
                .values(
                    status="projected",
                    payload="",
                    error_message=None,
                    processing_started_at=None,
                )
            )
            session.commit()

    async def mark_failed(
        self, batch_id: str, error: str, rejected: int = 0
    ) -> None:
        """Mark a batch as 'failed' with an error message."""
        with Session(engine) as session:
            batch = session.get(OtlpIngestBatchDB, batch_id)
            if batch is None:
                return
            batch.status = "failed"
            batch.error_message = error[:500]
            batch.processing_started_at = None
            batch.rejected_span_count += rejected
            session.add(batch)
            session.commit()

    async def mark_partial(
        self, batch_id: str, rejected: int, error: str
    ) -> None:
        """Record projection failures without hiding successful projections."""
        with Session(engine) as session:
            batch = session.get(OtlpIngestBatchDB, batch_id)
            if batch is None:
                return
            batch.status = "partial"
            batch.rejected_span_count += rejected
            batch.error_message = error[:500]
            batch.processing_started_at = None
            session.add(batch)
            session.commit()

    async def recover_stale(self) -> int:
        """Requeue only processing batches whose worker lease expired."""
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=QUEUE_LEASE_SECONDS)
        with Session(engine) as session:
            result = session.exec(
                update(OtlpIngestBatchDB)
                .where(
                    col(OtlpIngestBatchDB.status) == "processing",
                    (
                        col(OtlpIngestBatchDB.processing_started_at).is_(None)
                        | (col(OtlpIngestBatchDB.processing_started_at) < cutoff)
                    ),
                )
                .values(
                    status="queued",
                    error_message="Recovered after worker lease expired",
                    processing_started_at=None,
                )
            )
            session.commit()
            return int(result.rowcount or 0)


class QueueWorker:
    """Processes batches from the ingestion queue.

    Claims a batch and projects its already-persisted canonical spans
    through the projector (the receiver ran at accept time; this path never
    re-enters it), then marks the batch complete or failed.

    The worker is designed to run in the FastAPI process (background task or
    polling loop) for simple deployments. For production, it can run as a
    separate worker process.
    """

    def __init__(
        self,
        receiver: OtlpReceiver,
        queue: TraceIngestionQueue | None = None,
    ) -> None:
        self._receiver: OtlpReceiver = receiver
        self._queue: TraceIngestionQueue = queue or DbBackedQueue()

    async def process_one(self) -> bool:
        """Process a single batch from the queue.

        Returns True if a batch was processed, False if the queue was empty.
        """
        batch_id = await self._queue.claim_next()
        if batch_id is None:
            return False

        await self._process_claimed(batch_id)
        return True

    async def process_batch(self, batch_id: str) -> bool:
        """Claim and process one exact batch accepted by the caller."""
        claimed = await self._queue.claim(batch_id)
        if not claimed:
            return False
        await self._process_claimed(batch_id)
        return True

    async def _process_claimed(self, batch_id: str) -> None:
        try:
            # Issue #174: a heavy span-projection batch is seconds of sync SQL.
            # Run it off the event loop so request handling (heartbeats, result
            # submissions) keeps flowing while the batch projects. The projector
            # is stateless and each batch owns its Session, so concurrent batches
            # are safe; SQLite serializes the commits.
            result = await asyncio.to_thread(self._process_batch, batch_id)
        except Exception as exc:
            logger.error("Batch %s failed: %s", batch_id, exc, exc_info=True)
            await self._queue.mark_failed(batch_id, str(exc))
            return

        # The status transition is contained too: a transient SQLITE_BUSY
        # here (a VACUUM holding the write lock, say) must fail the mark,
        # not kill the worker — the batch stays 'processing' and its lease
        # expiry requeues it.
        try:
            if result.rejected == 0:
                await self._queue.mark_complete(batch_id)
                logger.info("Batch %s projected successfully", batch_id)
            elif result.projected > 0:
                message = "; ".join(result.errors[:5])
                await self._queue.mark_partial(batch_id, result.rejected, message)
                logger.warning(
                    "Batch %s projected partially (%d rejected)",
                    batch_id,
                    result.rejected,
                )
            else:
                await self._queue.mark_failed(
                    batch_id,
                    "; ".join(result.errors[:5]),
                    result.rejected,
                )
        except Exception:
            logger.exception(
                "Failed to record outcome for batch %s — it stays 'processing' and will be requeued when its lease expires",
                batch_id,
            )

    def _process_batch(self, batch_id: str) -> BatchProjectionResult:
        """Project already-persisted canonical spans for this batch.

        The receiver persisted spans to ``OtlpSpanDB`` during ingest with
        ``project_immediately=False``. This method reads the batch payload,
        finds the canonical spans, and projects each one through the projector.
        """
        from .trace_projector import get_trace_projector

        with Session(engine) as session:
            batch = session.get(OtlpIngestBatchDB, batch_id)
            if batch is None:
                raise ValueError(f"Batch {batch_id} not found")

            payload_str = batch.payload
            if not payload_str:
                raise ValueError(f"Batch {batch_id} has empty payload")

            decoded = json.loads(payload_str)
            projector = get_trace_projector()
            projected = 0
            rejected = 0
            errors: list[str] = []
            context = None
            if batch.verified_task_run_id is not None:
                from ..models.trace_ingestion import TraceIngestionContext

                context = TraceIngestionContext(
                    project_id=batch.project_id,
                    auth_method="service_token",
                    service_task_run_id=batch.verified_task_run_id,
                )

            for rs in decoded.get("resourceSpans", []):
                for ss in rs.get("scopeSpans", []):
                    for span_data in ss.get("spans", []):
                        trace_id = span_data.get("traceId", "")
                        span_id = span_data.get("spanId", "")
                        if not trace_id or not span_id:
                            continue
                        canonical = session.exec(
                            select(OtlpSpanDB).where(
                                OtlpSpanDB.project_id == batch.project_id,
                                OtlpSpanDB.trace_id == trace_id,
                                OtlpSpanDB.span_id == span_id,
                            )
                        ).first()
                        if canonical is None:
                            rejected += 1
                            errors.append(f"span {span_id}: canonical row not found")
                            continue

                        savepoint = session.begin_nested()
                        try:
                            projector.project(canonical, session, context)
                            savepoint.commit()
                            projected += 1
                        except Exception as exc:
                            savepoint.rollback()
                            rejected += 1
                            errors.append(f"span {span_id}: {exc}")
                            logger.warning(
                                "Projection failed for span %s (canonical kept)",
                                span_id,
                                exc_info=True,
                            )
            session.commit()
            return BatchProjectionResult(
                projected=projected,
                rejected=rejected,
                errors=tuple(errors),
            )

def queue_depth_report() -> dict[str, object]:
    """Queue health for the admin retention report.

    Depth and age of non-terminal batches — the signal that the worker is
    dead or a batch is looping, before payloads hit the stuck-batch
    horizon and get discarded.
    """
    now = datetime.now(timezone.utc)
    by_status: dict[str, int] = {}
    non_terminal: list[datetime] = []
    with Session(engine) as session:
        rows = session.exec(
            select(
                OtlpIngestBatchDB.status,
                func.count(),  # type: ignore[misc]
                func.min(OtlpIngestBatchDB.received_at),  # type: ignore[misc]
            ).group_by(OtlpIngestBatchDB.status)
        ).all()
    for status, count, oldest in rows:
        by_status[str(status)] = int(count)
        if status in ("queued", "processing"):
            non_terminal.append(oldest)
    report: dict[str, object] = {"by_status": by_status}
    if non_terminal:
        report["oldest_non_terminal_age_seconds"] = int(
            (now - min(non_terminal)).total_seconds()
        )
    return report


_worker_task: asyncio.Task[None] | None = None
_worker_stop: asyncio.Event | None = None


def start_trace_ingestion_worker() -> None:
    """Start the in-process durable queue worker and recover interrupted work."""
    global _worker_task, _worker_stop
    if _worker_task is not None and not _worker_task.done():
        return
    _worker_stop = asyncio.Event()
    _worker_task = asyncio.create_task(_run_worker(_worker_stop))


async def stop_trace_ingestion_worker() -> None:
    """Stop the in-process queue worker."""
    global _worker_task, _worker_stop
    if _worker_stop is not None:
        _worker_stop.set()
    if _worker_task is not None:
        _ = _worker_task.cancel()
        with suppress(asyncio.CancelledError):
            await _worker_task
    _worker_task = None
    _worker_stop = None


async def _run_worker(stop_event: asyncio.Event) -> None:
    queue = DbBackedQueue()
    recovered = await queue.recover_stale()
    if recovered:
        logger.warning("Recovered %d interrupted OTLP batch(es)", recovered)
    worker = QueueWorker(receiver=OtlpReceiver(), queue=queue)
    while not stop_event.is_set():
        # One raised exception (a claim hitting SQLITE_BUSY during a VACUUM,
        # a mark failing, anything) must never end the worker task silently —
        # batches would pile up 'queued' while the container stays healthy.
        # Log, back off briefly, keep draining.
        try:
            processed = await worker.process_one()
        except Exception:
            logger.exception("Ingestion worker iteration failed; continuing")
            processed = False
        if not processed:
            try:
                _ = await asyncio.wait_for(stop_event.wait(), timeout=1.0)
            except TimeoutError:
                pass
