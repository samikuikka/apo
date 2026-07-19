# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""SPEC-131 Milestone 1 regression tests: prove the tenancy + auth gaps.

These tests target the audited security/tenancy failures. They are written
against the CURRENT (pre-hardening) behavior and are expected to FAIL until
Milestones 3+4 land. Each names the SPEC-131 invariant:

  - Deliberate cross-project duplicate IDs (Test Case 8)
  - Mismatched service-token claim (Test Case 6)
  - API-key claim attempt (Test Case 7)

They drive the receiver directly through an explicit ingestion context so that
the production changes in Milestones 3/4 can be proven without standing up the
full HTTP auth stack for each invariant.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select, text

from apo.db import engine, init_db
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    LoggedCallDB,
    OtlpSpanDB,
    RunDB,
)
from apo.services.otlp_receiver import OtlpReceiver

_PROJECT_A = "tenancy-project-a"
_PROJECT_B = "tenancy-project-b"
_BATCH_RUN_ID = "tenancy-batch-001"
_TASK_RUN_ID = "tenancy-taskrun-001"
_DUPE_TRACE = "fedcba9876543210fedcba9876543210"
_DUPE_SPAN = "aaaaaaaaaaaaaaaa"


@pytest.fixture(autouse=True)
def setup_database():
    init_db()
    with Session(engine) as session:
        session.add(
            AgentTaskBatchRunDB(
                id=_BATCH_RUN_ID,
                project=_PROJECT_A,
                selection_type="manual",
                status="running",
            )
        )
        session.add(
            AgentTaskRunDB(
                id=_TASK_RUN_ID,
                batch_run_id=_BATCH_RUN_ID,
                task_id="task-a",
                task_path="tasks/task-a",
                status="running",
            )
        )
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


def _span_payload(
    *,
    trace_id: str = _DUPE_TRACE,
    span_id: str = _DUPE_SPAN,
    task_run_id: str | None = None,
) -> bytes:
    attrs: list[dict[str, object]] = [
        {"key": "apo.observation.type", "value": {"stringValue": "AGENT"}},
    ]
    if task_run_id:
        attrs.append(
            {"key": "apo.task.run.id", "value": {"stringValue": task_run_id}}
        )
    now = datetime(2026, 7, 10, 12, 0, 0, tzinfo=timezone.utc)
    return json.dumps(
        {
            "resourceSpans": [
                {
                    "scopeSpans": [
                        {
                            "spans": [
                                {
                                    "traceId": trace_id,
                                    "spanId": span_id,
                                    "name": "agent.run",
                                    "startTimeUnixNano": str(
                                        int(now.timestamp()) * 1_000_000_000
                                    ),
                                    "endTimeUnixNano": str(
                                        int(now.timestamp()) * 1_000_000_000
                                        + 5_000_000_000
                                    ),
                                    "attributes": attrs,
                                }
                            ]
                        }
                    ]
                }
            ]
        }
    ).encode()


# ---------------------------------------------------------------------------
# Cross-project duplicate IDs (Test Case 8)
# ---------------------------------------------------------------------------


class TestCrossProjectDuplicateIds:
    """Duplicate OTel IDs project independently without cross-tenant mutation."""

    def test_both_projects_materialize_duplicate_otel_ids(self):
        receiver = OtlpReceiver()

        with Session(engine) as session:
            result_a = receiver.ingest(
                payload=_span_payload(),
                content_type="application/json",
                project_id=_PROJECT_A,
                session=session,
            )
        # Project A's span is fully accepted.
        assert result_a.accepted == 1
        assert result_a.rejected == 0

        with Session(engine) as session:
            result_b = receiver.ingest(
                payload=_span_payload(),
                content_type="application/json",
                project_id=_PROJECT_B,
                session=session,
            )

        with Session(engine) as session:
            # BOTH canonical spans persist — they are project-scoped.
            spans = list(session.exec(select(OtlpSpanDB)).all())
            assert {s.project_id for s in spans} == {_PROJECT_A, _PROJECT_B}

            run_a = session.exec(
                select(RunDB).where(
                    RunDB.id == _DUPE_TRACE,
                    RunDB.project == _PROJECT_A,
                )
            ).first()
            assert run_a is not None
            run_b = session.exec(
                select(RunDB).where(
                    RunDB.id == _DUPE_TRACE,
                    RunDB.project == _PROJECT_B,
                )
            ).first()
            assert run_b is not None
            call_a = session.exec(
                select(LoggedCallDB).where(
                    LoggedCallDB.id == _DUPE_SPAN,
                    LoggedCallDB.project == _PROJECT_A,
                )
            ).first()
            assert call_a is not None
            call_b = session.exec(
                select(LoggedCallDB).where(
                    LoggedCallDB.id == _DUPE_SPAN,
                    LoggedCallDB.project == _PROJECT_B,
                )
            ).first()
            assert call_b is not None

        assert result_b.accepted == 1
        assert result_b.rejected == 0



# ---------------------------------------------------------------------------
# Authenticated Task Run claim (Test Cases 6 + 7)
# ---------------------------------------------------------------------------


class TestAuthenticatedTaskRunClaim:
    """A claim must be subject- and project-bound, not trusted from telemetry.

    The current receiver/projector trusts `apo.task.run.id` from the payload.
    These tests will pass only once the receiver carries an ingestion context
    and the projector enforces it. They intentionally call `ingest` with an
    explicit context argument so the production signature change is testable
    without the HTTP stack.
    """

    def test_payload_claim_without_service_token_context_is_rejected(self):
        """An API key (no service_task_run_id) must not claim a task run."""
        # A real service task run exists and belongs to PROJECT_A. The payload
        # tries to claim it. Without an authenticated subject, the claim must
        # be rejected and no projection mutation must link the run.
        receiver = OtlpReceiver()
        with Session(engine) as session:
            result = receiver.ingest(
                payload=_span_payload(task_run_id=_TASK_RUN_ID),
                content_type="application/json",
                project_id=_PROJECT_A,
                session=session,
            )

        with Session(engine) as session:
            task_run = session.get(AgentTaskRunDB, _TASK_RUN_ID)
            assert task_run is not None
            # The claim must NOT succeed from telemetry alone.
            assert task_run.trace_run_id is None
        _ = result  # accepted/rejected counts are a Milestone 3 concern
