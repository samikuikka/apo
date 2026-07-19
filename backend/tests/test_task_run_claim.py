# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""Tests for task-run trace claim via root span attributes (SPEC-129 Track 3.3).

When an OTLP root span carries ``apo.task.run.id``, the receiver should:
  1. Link the trace to the AgentTaskRunDB via ``trace_run_id``
  2. Enforce the one-trace invariant (reject a different second trace)
  3. Allow idempotent retries of the same trace
"""

import json
from datetime import datetime, timezone, timedelta

import pytest
from sqlmodel import Session, select, text
from apo.db import engine, init_db
from apo.models.db import (
    AgentTaskRunDB,
    AgentTaskBatchRunDB,
    OtlpSpanDB,
    RunDB,
)
from apo.models.trace_ingestion import TraceIngestionContext
from apo.services.otlp_receiver import OtlpReceiver

_TASK_RUN_ID = "taskrun-claim-001"
_BATCH_RUN_ID = "batchrun-claim-001"
_PROJECT_ID = "test-claim-project"


@pytest.fixture(autouse=True)
def setup_database():
    init_db()
    # Create a batch run + task run for the claim test
    with Session(engine) as session:
        batch = AgentTaskBatchRunDB(
            id=_BATCH_RUN_ID,
            project=_PROJECT_ID,
            selection_type="manual",
            status="running",
        )
        session.add(batch)
        task_run = AgentTaskRunDB(
            id=_TASK_RUN_ID,
            batch_run_id=_BATCH_RUN_ID,
            task_id="test-task",
            task_path="tasks/test",
            status="running",
        )
        session.add(task_run)
        session.commit()

    yield

    with Session(engine) as session:
        session.execute(text("DELETE FROM otlp_spans"))
        session.execute(text("DELETE FROM otlp_ingest_batches"))
        session.execute(text("DELETE FROM logged_calls"))
        session.execute(text("DELETE FROM call_metrics"))
        session.execute(text("DELETE FROM run_metrics"))
        session.execute(text("DELETE FROM runs"))
        session.execute(text("DELETE FROM agent_task_runs"))
        session.execute(text("DELETE FROM agent_task_batch_runs"))
        session.commit()


def _make_trace(
    trace_id: str,
    task_run_id: str | None = None,
    task_id: str | None = None,
) -> bytes:
    """Build an OTLP/JSON payload with a root span carrying task-run attributes."""
    attrs: list[dict[str, object]] = [
        {"key": "apo.observation.type", "value": {"stringValue": "AGENT"}},
    ]
    if task_run_id:
        attrs.append({"key": "apo.task.run.id", "value": {"stringValue": task_run_id}})
    if task_id:
        attrs.append({"key": "apo.task.id", "value": {"stringValue": task_id}})

    now = datetime.now(timezone.utc)
    # Derive a valid 16-hex span id from the trace id (not all zeros).
    span_id = trace_id[:16]
    return json.dumps({
        "resourceSpans": [{
            "scopeSpans": [{
                "spans": [{
                    "traceId": trace_id,
                    "spanId": span_id,
                    "name": "apo.task.run",
                    "startTime": now.isoformat(),
                    "endTime": (now + timedelta(seconds=5)).isoformat(),
                    "attributes": attrs,
                }],
            }],
        }],
    }).encode()


def _service_token_context(task_run_id: str = _TASK_RUN_ID) -> TraceIngestionContext:
    """An authenticated service-token context whose subject may claim the run."""
    return TraceIngestionContext(
        project_id=_PROJECT_ID,
        auth_method="service_token",
        service_task_run_id=task_run_id,
    )


class TestTaskRunClaim:
    """Root span with apo.task.run.id links the trace to the task run."""

    def test_root_span_claims_trace_for_task_run(self):
        """A root span with apo.task.run.id sets AgentTaskRunDB.trace_run_id."""
        trace_id = "0123456789abcdef0123456789abcde1"
        payload = _make_trace(trace_id, task_run_id=_TASK_RUN_ID)

        receiver = OtlpReceiver()
        with Session(engine) as session:
            result = receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id=_PROJECT_ID,
                session=session,
                context=_service_token_context(),
            )

        assert result.accepted == 1
        assert result.errors == []

        with Session(engine) as session:
            task_run = session.get(AgentTaskRunDB, _TASK_RUN_ID)
            assert task_run is not None
            assert task_run.trace_run_id == trace_id

    def test_idempotent_retry_same_trace(self):
        """Re-sending the same trace is idempotent — doesn't error."""
        trace_id = "0123456789abcdef0123456789abcde2"
        payload = _make_trace(trace_id, task_run_id=_TASK_RUN_ID)

        receiver = OtlpReceiver()

        with Session(engine) as session:
            receiver.ingest(payload=payload, content_type="application/json",
                           project_id=_PROJECT_ID, session=session,
                           context=_service_token_context())

        with Session(engine) as session:
            receiver.ingest(payload=payload, content_type="application/json",
                           project_id=_PROJECT_ID, session=session,
                           context=_service_token_context())

        with Session(engine) as session:
            task_run = session.get(AgentTaskRunDB, _TASK_RUN_ID)
            assert task_run is not None
            assert task_run.trace_run_id == trace_id

    def test_second_different_trace_rejected(self):
        """A second, different trace for the same task run is rejected."""
        trace1 = "0123456789abcdef0123456789abcde3"
        trace2 = "0123456789abcdef0123456789abcde4"

        receiver = OtlpReceiver()

        with Session(engine) as session:
            receiver.ingest(
                payload=_make_trace(trace1, task_run_id=_TASK_RUN_ID),
                content_type="application/json",
                project_id=_PROJECT_ID,
                session=session,
                context=_service_token_context(),
            )

        with Session(engine) as session:
            receiver.ingest(
                payload=_make_trace(trace2, task_run_id=_TASK_RUN_ID),
                content_type="application/json",
                project_id=_PROJECT_ID,
                session=session,
                context=_service_token_context(),
            )

        # The second trace's span should be rejected (or at least the claim
        # should not change)
        with Session(engine) as session:
            task_run = session.get(AgentTaskRunDB, _TASK_RUN_ID)
            assert task_run is not None
            # The claim stays as trace1 — trace2 must not overwrite
            assert task_run.trace_run_id == trace1

    def test_run_projected_with_task_run_id(self):
        """The projected RunDB row gets task_run_id set from the claim."""
        trace_id = "0123456789abcdef0123456789abcde5"
        payload = _make_trace(trace_id, task_run_id=_TASK_RUN_ID, task_id="test-task")

        receiver = OtlpReceiver()
        with Session(engine) as session:
            receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id=_PROJECT_ID,
                session=session,
                context=_service_token_context(),
            )

        with Session(engine) as session:
            run = session.exec(select(RunDB).where(RunDB.id == trace_id)).first()
            assert run is not None
            assert run.task_run_id == _TASK_RUN_ID

    def test_claim_rejected_when_attribute_does_not_match_token_subject(self):
        """A root span whose apo.task.run.id != token subject must NOT claim.

        This is the SPEC-129 §7.3 security boundary: the OTLP receiver validates
        the root claim before associating the OTel trace ID with the task run.
        A token for task run A cannot claim task run B by emitting B's id in the
        span attributes. Locks the attribute-name contract the SDK emits.
        """
        trace_id = "0123456789abcdef0123456789abcde6"
        # Root span claims a DIFFERENT task run than the token's subject.
        payload = _make_trace(trace_id, task_run_id="someone-elses-run")

        receiver = OtlpReceiver()
        with Session(engine) as session:
            result = receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id=_PROJECT_ID,
                session=session,
                context=_service_token_context(task_run_id=_TASK_RUN_ID),
            )

        # The span is still accepted as canonical telemetry...
        assert result.accepted == 1
        # ...but the claim must NOT fire — the token's task run is untouched.
        with Session(engine) as session:
            task_run = session.get(AgentTaskRunDB, _TASK_RUN_ID)
            assert task_run is not None
            assert task_run.trace_run_id is None

    def test_api_key_cannot_claim_task_run(self):
        """Only a service token may claim; an API key may not, even with attrs."""
        trace_id = "0123456789abcdef0123456789abcde7"
        payload = _make_trace(trace_id, task_run_id=_TASK_RUN_ID)

        api_key_context = TraceIngestionContext(
            project_id=_PROJECT_ID,
            auth_method="api_key",
            service_task_run_id=None,
        )
        receiver = OtlpReceiver()
        with Session(engine) as session:
            receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id=_PROJECT_ID,
                session=session,
                context=api_key_context,
            )

        with Session(engine) as session:
            task_run = session.get(AgentTaskRunDB, _TASK_RUN_ID)
            assert task_run is not None
            assert task_run.trace_run_id is None
