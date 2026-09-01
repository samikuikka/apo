"""Dev capture tooling roundtrip.

Proves the capture loop without spending LLM credits: seed capture-project
rows (including a REAL OTLP ingest through the receiver), export the delta,
merge into a fixture copy, reload it through the production loader, and
verify the surface checklist.
"""

# pyright: reportPrivateUsage=false, reportAny=false, reportUnusedCallResult=false

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlmodel import Session, SQLModel, col, select
from sqlalchemy import create_engine as sa_create_engine

from apo.dev_demo_capture import (
    CAPTURE_PROJECT_ID,
    apply_pins,
    export_delta,
    merge_into_fixture,
    run_checklist,
)
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskJudgmentDB,
    AgentTaskDeliverableDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    AgentTaskScheduleOccurrenceDB,
    ProjectDB,
    RunDB,
    UserDB,
)
from apo.models.trace_ingestion import TraceIngestionContext
from apo.services.check_report_storage import persist_check_report
from apo.services.demo_fixture import load_demo_fixture
from apo.services.otlp_receiver import OtlpReceiver

TRACE_ID = "cab0000000000000000000000000000a"
SPAN_ROOT = "cab000000000000a"
SPAN_CHILD = "cab000000000000b"


@pytest.fixture(name="capture_world")
def capture_world_fixture(tmp_path_factory: pytest.TempPathFactory) -> Session:
    """A capture project with one batch, one failed run (check report,
    judgment), and a real ingested OTLP trace claiming that run."""
    # Private scratch DB: the OTLP ingest nests savepoints inside one long
    # transaction; sharing the suite engine let savepoint state bleed into
    # unrelated tests (same isolation as tests/test_demo_fixture.py).
    engine = sa_create_engine(f"sqlite:///{tmp_path_factory.mktemp('cap')}/capture.db")
    SQLModel.metadata.create_all(engine)
    session = Session(engine)
    try:
        yield _seed_capture_world(session)
    finally:
        session.close()
        engine.dispose()


def _seed_capture_world(session: Session) -> Session:
    session.add(ProjectDB(id=CAPTURE_PROJECT_ID, name="Demo capture"))
    session.add(
        UserDB(
            id="capturing-human",
            email="capturer@apo.invalid",
            password_hash="!",
        )
    )
    session.commit()

    now = datetime.now(timezone.utc)
    batch = AgentTaskBatchRunDB(
        id="cap-batch-001",
        project=CAPTURE_PROJECT_ID,
        selection_type="all",
        environment="demo",
        status="completed",
        requested_by_user_id="capturing-human",
        created_at=now,
        started_at=now,
        completed_at=now,
    )
    session.add(batch)
    session.flush()
    run = AgentTaskRunDB(
        id="cap-run-001",
        batch_run_id=batch.id,
        task_id="real-agent/documents/document-qa",
        task_path="",
        status="failed",
        pass_result=False,
        configured_model="deepseek/deepseek-v4-flash-0731",
        started_at=now,
        completed_at=now,
    )
    session.add(run)
    session.flush()
    persist_check_report(
        session,
        run,
        [
            {
                "id": "cites-invoice-date",
                "pass": False,
                "reasoning": "date never appears",
                "assertions": [
                    {"id": "invoice-date", "pass": False, "outcome": "fail", "expected": "2024-03-17", "received": None}
                ],
            },
            {"id": "mentions-counterparty", "pass": True, "reasoning": "named"},
        ],
    )
    session.add(
        AgentTaskJudgmentDB(
            id="cap-jdg-001",
            task_run_id=run.id,
            project=CAPTURE_PROJECT_ID,
            trigger="rejudge",
            label="reasoning-first",
            judge_model="google/gemini-2.5-flash-lite",
            samples=3,
            pass_result=False,
            total_checks=2,
            passed_checks=1,
            failed_checks=1,
            checks_json=[
                {"id": "cites-invoice-date", "pass": False},
                {"id": "mentions-counterparty", "pass": True},
            ],
            created_at=now,
        )
    )
    session.add(
        AgentTaskDeliverableDB(
            id="cap-dlv-001",
            project=CAPTURE_PROJECT_ID,
            task_run_id=run.id,
            name="memo",
            kind="json",
            status="ready",
            inline_value_json={"value": {"summary": "captured memo"}},
            media_type="application/json",
            size_bytes=32,
            stored_size_bytes=32,
            sha256="0" * 64,
            created_at=now,
            ready_at=now,
        )
    )
    session.add(
        AgentTaskScheduleDB(
            id="cap-sched-001",
            project=CAPTURE_PROJECT_ID,
            name="Weekly",
            selection_type="all",
            cadence_type="weekly",
            enabled=False,
            created_at=now,
            updated_at=now,
        )
    )
    session.add(
        AgentTaskScheduleOccurrenceDB(
            id="cap-occ-001",
            project=CAPTURE_PROJECT_ID,
            schedule_id="cap-sched-001",
            schedule_name="Weekly",
            kind="scheduled",
            scheduled_for=now,
            status="delivered",
            batch_run_id="cap-batch-001",
            resolved_at=now,
            created_at=now,
        )
    )
    session.commit()

    OtlpReceiver().ingest(
        payload=json.dumps(_otel_trace()).encode(),
        content_type="application/json",
        project_id=CAPTURE_PROJECT_ID,
        session=session,
        context=TraceIngestionContext(
            project_id=CAPTURE_PROJECT_ID,
            auth_method="service_token",
            service_task_run_id="cap-run-001",
        ),
        project_immediately=True,
    )
    session.commit()
    return session


def _otel_trace() -> dict[str, object]:
    def attr(key: str, string_value: str) -> dict[str, object]:
        return {"key": key, "value": {"stringValue": string_value}}

    return {
        "resourceSpans": [
            {
                "scopeSpans": [
                    {
                        "spans": [
                            {
                                "traceId": TRACE_ID,
                                "spanId": SPAN_ROOT,
                                "name": "agent-task-run",
                                "startTime": "2026-08-29T10:00:00.000000Z",
                                "endTime": "2026-08-29T10:01:00.000000Z",
                                "attributes": [
                                    attr("apo.task.run.id", "cap-run-001"),
                                    attr("apo.run.task_id", "real-agent/documents/document-qa"),
                                ],
                            },
                            {
                                "traceId": TRACE_ID,
                                "spanId": SPAN_CHILD,
                                "parentSpanId": SPAN_ROOT,
                                "name": "chat",
                                "startTime": "2026-08-29T10:00:01.000000Z",
                                "endTime": "2026-08-29T10:00:02.000000Z",
                                "attributes": [
                                    attr("apo.observation.type", "GENERATION"),
                                    attr("gen_ai.request.model", "deepseek/deepseek-v4-flash-0731"),
                                    {"key": "gen_ai.usage.input_tokens", "value": {"intValue": "100"}},
                                    {"key": "gen_ai.usage.output_tokens", "value": {"intValue": "50"}},
                                ],
                            },
                        ]
                    }
                ]
            }
        ]
    }


class TestExportMerge:
    def test_roundtrip_export_merge_reload(self, capture_world: Session, tmp_path: Path) -> None:
        # Export everything created "since before the world began".
        delta = export_delta(capture_world, datetime(2020, 1, 1, tzinfo=timezone.utc))
        assert len(delta["batches"]) == 1
        run_spec = delta["batches"][0]["runs"][0]
        assert run_spec["check_report"] is not None
        assert run_spec["otel_trace"] is not None
        assert delta["demo_user"]["id"] == "demo-user"

        # Pin the anchor ids the guide rail depends on.
        apply_pins(delta, {"cap-run-001": "demo-run-042", "cap-batch-001": "demo-batch-042"})
        assert delta["batches"][0]["id"] == "demo-batch-042"

        fixture_path = tmp_path / "merged.json"
        merge_into_fixture(delta, fixture_path)
        document = json.loads(fixture_path.read_text())
        assert document["batches"][0]["runs"][0]["id"] == "demo-run-042"

        # Reload through the production loader into a scratch DB.
        scratch_engine = sa_create_engine(f"sqlite:///{tmp_path}/reload.db")
        SQLModel.metadata.create_all(scratch_engine)
        with Session(scratch_engine) as scratch:
            scratch.add(ProjectDB(id="demo", name="Demo workspace"))
            scratch.commit()
            assert load_demo_fixture(scratch, path=fixture_path) is True

            run = scratch.get(AgentTaskRunDB, "demo-run-042")
            assert run is not None
            assert run.status == "failed"
            # The OTLP payload replayed: claim + projection.
            assert run.trace_run_id is not None
            trace = scratch.exec(
                select(RunDB).where(
                    RunDB.id == run.trace_run_id, RunDB.project == "demo"
                )
            ).first()
            assert trace is not None
            assert trace.task_run_id == "demo-run-042"

    def test_watermark_excludes_older_batches(self, capture_world: Session) -> None:
        future = datetime.now(timezone.utc).replace(year=2100)
        delta = export_delta(capture_world, future)
        assert delta["batches"] == []

    def test_merge_is_idempotent_on_ids(self, capture_world: Session, tmp_path: Path) -> None:
        delta = export_delta(capture_world, datetime(2020, 1, 1, tzinfo=timezone.utc))
        fixture_path = tmp_path / "merged.json"
        merge_into_fixture(delta, fixture_path)
        merge_into_fixture(delta, fixture_path)
        document = json.loads(fixture_path.read_text())
        assert len(document["batches"]) == 1


class TestVerifyChecklist:
    def test_checklist_passes_on_rich_dataset(self, capture_world: Session, tmp_path: Path) -> None:
        # Two models are required for the comparison story: add a second
        # batch with a frontier-model run.
        now = datetime.now(timezone.utc)
        session = capture_world
        batch2 = AgentTaskBatchRunDB(
            id="cap-batch-002",
            project=CAPTURE_PROJECT_ID,
            selection_type="all",
            environment="demo",
            status="completed",
            requested_by_user_id="capturing-human",
            created_at=now,
        )
        session.add(batch2)
        session.flush()
        run2 = AgentTaskRunDB(
            id="cap-run-002",
            batch_run_id=batch2.id,
            task_id="real-agent/documents/document-qa",
            task_path="",
            status="passed",
            pass_result=True,
            configured_model="anthropic/claude-sonnet-4.5",
        )
        session.add(run2)
        session.flush()
        run3 = AgentTaskRunDB(
            id="cap-run-003",
            batch_run_id=batch2.id,
            task_id="real-agent/engineering/api-testing",
            task_path="",
            status="error",
            pass_result=None,
            configured_model="anthropic/claude-sonnet-4.5",
            error_message="adapter crashed",
        )
        session.add(run3)
        session.flush()
        persist_check_report(session, run2, [{"id": "cites-invoice-date", "pass": True, "reasoning": "ok"}])
        session.commit()

        delta = export_delta(session, datetime(2020, 1, 1, tzinfo=timezone.utc))
        fixture_path = tmp_path / "merged.json"
        merge_into_fixture(delta, fixture_path)

        scratch_engine = sa_create_engine(f"sqlite:///{tmp_path}/verify.db")
        SQLModel.metadata.create_all(scratch_engine)
        with Session(scratch_engine) as scratch:
            scratch.add(ProjectDB(id="demo", name="Demo workspace"))
            scratch.commit()
            assert load_demo_fixture(scratch, path=fixture_path) is True
            failures = run_checklist(scratch)
        assert failures == [], failures

    def test_checklist_flags_thin_dataset(self, session: Session) -> None:
        # An empty demo dataset must fail the checklist loudly.
        failures = run_checklist(session)
        assert any("no batches" in f for f in failures)
