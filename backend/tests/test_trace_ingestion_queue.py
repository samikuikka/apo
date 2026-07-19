# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""Tests for the TraceIngestionQueue (SPEC-129 §2).

The queue decouples OTLP acceptance from projection. The receiver persists
the raw batch, enqueues its batch_id, and returns an OTLP response. A worker
claims batches from the queue, processes them (persist canonical spans +
project), and marks them complete or failed.

The first implementation is DB-backed (polling). It must be replaceable with
Redis/SQS without changing the protocol.
"""

import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import Session, select, text
from apo.db import engine, init_db
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    OtlpIngestBatchDB,
    OtlpSpanDB,
    RunDB,
    LoggedCallDB,
)
from apo.models.trace_ingestion import TraceIngestionContext
from apo.services.trace_ingestion_queue import (
    TraceIngestionQueue,
    DbBackedQueue,
    QueueWorker,
)
from apo.services.otlp_receiver import OtlpReceiver
from apo.services.trace_projector import TraceProjector


@pytest.fixture(autouse=True)
def setup_database():
    init_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM call_metrics"))
        session.execute(text("DELETE FROM run_metrics"))
        session.execute(text("DELETE FROM logged_calls"))
        session.execute(text("DELETE FROM otlp_spans"))
        session.execute(text("DELETE FROM otlp_ingest_batches"))
        session.execute(text("DELETE FROM runs"))
        session.execute(text("DELETE FROM agent_task_runs"))
        session.execute(text("DELETE FROM agent_task_batch_runs"))
        session.commit()


class TestDbBackedQueue:
    """The DB-backed queue implements the TraceIngestionQueue protocol."""

    def test_enqueue_marks_batch_as_queued(self):
        """enqueue() sets batch status to 'queued' so the worker can find it."""
        queue = DbBackedQueue()
        with Session(engine) as session:
            batch = OtlpIngestBatchDB(
                id="queue-test-001",
                project_id="test",
                content_type="application/json",
                payload_sha256="abc",
                payload="{}",
                status="accepted",
                accepted_span_count=1,
            )
            session.add(batch)
            session.commit()

            asyncio.run(queue.enqueue("queue-test-001"))

            batch = session.get(OtlpIngestBatchDB, "queue-test-001")
            assert batch.status == "queued"

    def test_claim_next_returns_oldest_queued_batch(self):
        """claim_next() returns the oldest batch with status='queued'."""
        queue = DbBackedQueue()
        with Session(engine) as session:
            for i in range(3):
                batch = OtlpIngestBatchDB(
                    id=f"queue-test-{i:03d}",
                    project_id="test",
                    content_type="application/json",
                    payload_sha256="abc",
                    payload="{}",
                    status="queued",
                )
                session.add(batch)
            session.commit()

        batch_id = asyncio.run(queue.claim_next())
        assert batch_id == "queue-test-000"  # oldest first

    def test_claim_next_marks_batch_as_processing(self):
        """claim_next() atomically marks the batch as 'processing'."""
        queue = DbBackedQueue()
        with Session(engine) as session:
            session.add(OtlpIngestBatchDB(
                id="queue-claim-001", project_id="test", content_type="application/json",
                payload_sha256="", payload="{}", status="queued",
            ))
            session.commit()

        batch_id = asyncio.run(queue.claim_next())
        assert batch_id == "queue-claim-001"

        with Session(engine) as session:
            batch = session.get(OtlpIngestBatchDB, "queue-claim-001")
            assert batch.status == "processing"

    def test_claim_next_returns_none_when_empty(self):
        """claim_next() returns None when no batches are queued."""
        queue = DbBackedQueue()
        result = asyncio.run(queue.claim_next())
        assert result is None

    def test_claim_targets_exact_batch(self):
        """claim(batch_id) does not consume an older unrelated batch."""
        queue = DbBackedQueue()
        with Session(engine) as session:
            for batch_id in ("queue-exact-old", "queue-exact-new"):
                session.add(OtlpIngestBatchDB(
                    id=batch_id, project_id="test", content_type="application/json",
                    payload_sha256="", payload="{}", status="queued",
                ))
            session.commit()

        assert asyncio.run(queue.claim("queue-exact-new")) is True
        with Session(engine) as session:
            assert session.get(OtlpIngestBatchDB, "queue-exact-old").status == "queued"
            assert session.get(OtlpIngestBatchDB, "queue-exact-new").status == "processing"

    def test_mark_complete_sets_status(self):
        """mark_complete() sets batch status to 'projected'."""
        queue = DbBackedQueue()
        with Session(engine) as session:
            session.add(OtlpIngestBatchDB(
                id="queue-done-001", project_id="test", content_type="application/json",
                payload_sha256="", payload="{}", status="processing",
            ))
            session.commit()

        asyncio.run(queue.mark_complete("queue-done-001"))

        with Session(engine) as session:
            batch = session.get(OtlpIngestBatchDB, "queue-done-001")
            assert batch.status == "projected"

    def test_mark_failed_sets_status_and_error(self):
        """mark_failed() sets status to 'failed' and records the error."""
        queue = DbBackedQueue()
        with Session(engine) as session:
            session.add(OtlpIngestBatchDB(
                id="queue-fail-001", project_id="test", content_type="application/json",
                payload_sha256="", payload="{}", status="processing",
            ))
            session.commit()

        asyncio.run(queue.mark_failed("queue-fail-001", "projection crashed"))

        with Session(engine) as session:
            batch = session.get(OtlpIngestBatchDB, "queue-fail-001")
            assert batch.status == "failed"
            assert "projection crashed" in (batch.error_message or "")

    def test_failed_batch_can_be_retried(self):
        """A failed batch goes back to 'queued' for retry."""
        queue = DbBackedQueue()
        with Session(engine) as session:
            session.add(OtlpIngestBatchDB(
                id="queue-retry-001", project_id="test", content_type="application/json",
                payload_sha256="", payload="{}", status="failed", error_message="oops",
            ))
            session.commit()

        # Retry: re-enqueue the failed batch
        asyncio.run(queue.enqueue("queue-retry-001"))

        with Session(engine) as session:
            batch = session.get(OtlpIngestBatchDB, "queue-retry-001")
            assert batch.status == "queued"
            assert batch.error_message is None  # error cleared

    def test_recover_stale_requeues_processing_batches(self):
        queue = DbBackedQueue()
        with Session(engine) as session:
            session.add(OtlpIngestBatchDB(
                id="queue-stale-001", project_id="test", content_type="application/json",
                payload_sha256="", payload="{}", status="processing",
                processing_started_at=datetime.now(timezone.utc) - timedelta(hours=1),
            ))
            session.commit()

        assert asyncio.run(queue.recover_stale()) == 1
        with Session(engine) as session:
            batch = session.get(OtlpIngestBatchDB, "queue-stale-001")
            assert batch is not None
            assert batch.status == "queued"

    def test_recover_stale_keeps_live_worker_lease(self):
        queue = DbBackedQueue()
        with Session(engine) as session:
            session.add(OtlpIngestBatchDB(
                id="queue-live-001", project_id="test", content_type="application/json",
                payload_sha256="", payload="{}", status="processing",
                processing_started_at=datetime.now(timezone.utc),
            ))
            session.commit()

        assert asyncio.run(queue.recover_stale()) == 0
        with Session(engine) as session:
            batch = session.get(OtlpIngestBatchDB, "queue-live-001")
            assert batch is not None
            assert batch.status == "processing"


class TestQueueWorker:
    """The worker processes batches from the queue."""

    def test_worker_processes_queued_batch(self):
        """The worker picks a batch, processes spans, marks it complete."""
        # Create a batch with a real OTLP payload
        payload = json.dumps({
            "resourceSpans": [{
                "scopeSpans": [{
                    "spans": [{
                        "traceId": "a001000000000000000000000000000a",
                        "spanId": "a00100000000000a",
                        "name": "worker-test-span",
                        "startTime": "2026-07-10T12:00:00Z",
                        "endTime": "2026-07-10T12:00:01Z",
                        "attributes": [
                            {"key": "gen_ai.request.model", "value": {"stringValue": "gpt-4o"}},
                        ],
                    }],
                }],
            }],
        }).encode()

        receiver = OtlpReceiver()
        worker = QueueWorker(receiver=receiver)

        # Step 1: receiver accepts the batch (persists inbox + spans, NO projection)
        with Session(engine) as session:
            result = receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id="test-worker",
                session=session,
                project_immediately=False,
            )
        assert result.accepted == 1

        # Step 2: worker processes the queue
        processed = asyncio.run(worker.process_one())
        assert processed is True

        # Step 3: verify the batch is projected
        with Session(engine) as session:
            batch = session.exec(
                select(OtlpIngestBatchDB).where(OtlpIngestBatchDB.project_id == "test-worker")
            ).first()
            assert batch.status == "projected"

            # Spans should exist in the canonical store
            spans = session.exec(select(OtlpSpanDB)).all()
            assert len(spans) >= 1

    def test_worker_returns_false_when_queue_empty(self):
        """When no batches are queued, process_one() returns False."""
        worker = QueueWorker(receiver=OtlpReceiver())
        result = asyncio.run(worker.process_one())
        assert result is False

    def test_async_projection_preserves_verified_task_run_claim(self):
        """The request-time verified claim survives the durable queue boundary."""
        project = "queue-claim-project"
        batch_run_id = "queue-claim-batch"
        task_run_id = "queue-claim-task"
        trace_id = "b001000000000000000000000000000b"
        payload = json.dumps({
            "resourceSpans": [{"scopeSpans": [{"spans": [{
                "traceId": trace_id,
                "spanId": "b00100000000000b",
                "name": "apo.task.run",
                "startTime": "2026-07-12T10:00:00Z",
                "endTime": "2026-07-12T10:00:01Z",
                "attributes": [
                    {"key": "apo.observation.type", "value": {"stringValue": "AGENT"}},
                    {"key": "apo.task.run.id", "value": {"stringValue": task_run_id}},
                ],
            }]}]}],
        }).encode()

        with Session(engine) as session:
            session.add(AgentTaskBatchRunDB(
                id=batch_run_id,
                project=project,
                selection_type="manual",
                status="running",
            ))
            session.add(AgentTaskRunDB(
                id=task_run_id,
                batch_run_id=batch_run_id,
                task_id="task",
                task_path="tasks/task",
                status="running",
            ))
            session.commit()

        context = TraceIngestionContext(
            project_id=project,
            auth_method="service_token",
            service_task_run_id=task_run_id,
        )
        with Session(engine) as session:
            result = OtlpReceiver().ingest(
                payload=payload,
                content_type="application/json",
                project_id=project,
                session=session,
                context=context,
                project_immediately=False,
            )

        processed = asyncio.run(
            QueueWorker(receiver=OtlpReceiver()).process_batch(result.batch_id)
        )
        assert processed is True

        with Session(engine) as session:
            task_run = session.get(AgentTaskRunDB, task_run_id)
            batch = session.get(OtlpIngestBatchDB, result.batch_id)
            run = session.exec(select(RunDB).where(RunDB.id == trace_id)).first()
            assert task_run is not None
            assert batch is not None
            assert run is not None
            assert task_run.trace_run_id == trace_id
            assert batch.verified_task_run_id == task_run_id
            assert batch.status == "projected"
            assert run.task_run_id == task_run_id

    def test_worker_marks_failed_batch_on_error(self):
        """If projection fails, the batch is marked failed with the error."""
        payload = json.dumps({
            "resourceSpans": [{
                "scopeSpans": [{
                    "spans": [{
                        "traceId": "a002000000000000000000000000000a",
                        "spanId": "a00200000000000a",
                        "name": "ok-span",
                        "startTime": "2026-07-10T12:00:00Z",
                        "endTime": "2026-07-10T12:00:01Z",
                    }],
                }],
            }],
        }).encode()

        receiver = OtlpReceiver()
        worker = QueueWorker(receiver=receiver)

        with Session(engine) as session:
            receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id="test-fail",
                session=session,
                project_immediately=False,
            )

        # Corrupt the batch payload to force a processing failure
        with Session(engine) as session:
            batch = session.exec(
                select(OtlpIngestBatchDB).where(OtlpIngestBatchDB.project_id == "test-fail")
            ).first()
            batch.payload = "corrupted-json{"
            session.add(batch)
            session.commit()

        asyncio.run(worker.process_one())

        with Session(engine) as session:
            batch = session.exec(
                select(OtlpIngestBatchDB).where(OtlpIngestBatchDB.project_id == "test-fail")
            ).first()
            assert batch.status == "failed"
            assert batch.error_message is not None

    def test_worker_marks_mixed_projection_result_partial(self, monkeypatch):
        payload = json.dumps({
            "resourceSpans": [{"scopeSpans": [{"spans": [
                {
                    "traceId": "a003000000000000000000000000000a",
                    "spanId": "a00300000000000a",
                    "name": "root-ok",
                    "startTime": "2026-07-10T12:00:00Z",
                    "endTime": "2026-07-10T12:00:01Z",
                },
                {
                    "traceId": "a003000000000000000000000000000a",
                    "spanId": "a00300000000000b",
                    "parentSpanId": "a00300000000000a",
                    "name": "child-fails",
                    "startTime": "2026-07-10T12:00:00Z",
                    "endTime": "2026-07-10T12:00:01Z",
                },
            ]}]}],
        }).encode()
        original_project = TraceProjector.project

        def fail_child(self, span, session, context=None):
            if span.span_name == "child-fails":
                raise RuntimeError("intentional projection failure")
            return original_project(self, span, session, context)

        monkeypatch.setattr(TraceProjector, "project", fail_child)
        with Session(engine) as session:
            result = OtlpReceiver().ingest(
                payload=payload,
                content_type="application/json",
                project_id="test-partial",
                session=session,
                project_immediately=False,
            )

        processed = asyncio.run(
            QueueWorker(receiver=OtlpReceiver()).process_batch(result.batch_id)
        )
        assert processed is True
        with Session(engine) as session:
            batch = session.get(OtlpIngestBatchDB, result.batch_id)
            assert batch is not None
            assert batch.status == "partial"
            assert batch.rejected_span_count == 1
            assert "intentional projection failure" in (batch.error_message or "")
